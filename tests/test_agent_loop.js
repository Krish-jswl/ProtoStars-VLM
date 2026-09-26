import { test } from 'node:test';
import assert from 'node:assert';
import { AgentLoop } from '../extension/background/agent_loop.js';

function observedContext() {
    return {
        allowed: true,
        sanitizedContext: {
            goal: 'add a task named "Run"',
            page: {
                url: 'https://example.test/tasks',
                title: 'Tasks',
                viewport: { width: 100, height: 100 }
            },
            dom: [{
                id: 'add-task',
                tag: 'button',
                text: 'Add task',
                bbox: { x: 0, y: 0, width: 100, height: 30 },
                visible: true,
                enabled: true
            }],
            image: 'data:image/jpeg;base64,redacted'
        },
        redactionPlan: []
    };
}

test('bounded task discovery falls through to the next local tier', () => {
    const loop = new AgentLoop(8, 'add a task named "GOC"');
    const updates = [];
    loop.running = true;
    loop._generation = 0;
    loop._broadcast = update => updates.push(update);
    loop._scheduleNextCycle = () => {};

    for (let attempt = 0; attempt < 7; attempt++) {
        assert.strictEqual(loop._holdTaskDiscovery(0), true);
    }
    assert.strictEqual(loop._holdTaskDiscovery(0), false);
    assert.strictEqual(loop.running, true);
    assert.ok(updates.some(update =>
        update.log && /continuing with local vision/i.test(update.log)
    ));
});

test('task discovery exhaustion reaches local vision and the privacy tier', async () => {
    const loop = new AgentLoop(9, 'add a task named "GOC"');
    let visionCalls = 0;
    let privacyCalls = 0;
    let planCalls = 0;
    const dom = [{
        id: 'empty-page',
        tag: 'main',
        text: 'Task page',
        inputType: '',
        bbox: { x: 0, y: 0, width: 400, height: 200 },
        visible: true,
        enabled: true
    }];

    loop.localAgent = {
        analyze: () => ({ decision: 'SERVER', reason: 'task editor is not visible yet', actions: [] })
    };
    loop.localVisionAgent = {
        shouldAttempt: () => true,
        analyze: async () => {
            visionCalls++;
            return { decision: 'SERVER', localVisionUnavailable: true, metrics: {} };
        }
    };
    loop._sendToContent = async type => {
        if (type === 'ANALYZE_DOM') return { elements: dom };
        if (type === 'LOCAL_VISION_OBSERVE') {
            return { dom, image: 'data:image/jpeg;base64,local' };
        }
        if (type === 'PRIVACY_PIPELINE') {
            privacyCalls++;
            return observedContext();
        }
        return null;
    };
    loop.client.plan = async () => {
        planCalls++;
        return { success: false, error: 'test stop' };
    };
    loop._broadcast = () => {};
    loop._backoff = async () => {};
    loop._sleep = async () => {};
    loop.running = true;
    loop._generation = 0;

    const scheduled = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = callback => {
        scheduled.push(callback);
        return scheduled.length;
    };
    try {
        await loop._cycle(0);
        let iterations = 0;
        while (loop.running && scheduled.length && iterations++ < 12) {
            await scheduled.shift()();
        }
        assert.strictEqual(visionCalls, 1);
        assert.strictEqual(privacyCalls, 1);
        assert.strictEqual(planCalls, 1);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }
});

test('plan intake refuses task text aimed at an email field', () => {
    const loop = new AgentLoop(10, 'add a task named "GOC"');
    const dom = [{
        id: 'email',
        tag: 'input',
        role: 'textbox',
        inputType: 'email',
        autocomplete: 'email',
        ariaLabel: 'Email',
        bbox: { x: 0, y: 0, width: 200, height: 30 },
        visible: true,
        enabled: true
    }];
    const queued = loop._queuePlan([
        { type: 'type_local', target: 'email', args: { text: 'GOC' } },
        { type: 'done', target: '', args: {} }
    ], dom, 'local', { reason: 'test' });
    assert.deepStrictEqual(queued, { accepted: false, blocked: false });
    assert.strictEqual(loop._pendingPlan, null);
});

test('an unsafe identity action is dropped without discarding the valid steps', () => {
    const loop = new AgentLoop(30, 'Login and task "Study Cpp"');
    const updates = [];
    loop.running = true;
    loop._generation = 0;
    loop._broadcast = update => updates.push(update);
    const dom = [
        { id: 'email', tag: 'input', inputType: 'email', autocomplete: 'email', ariaLabel: 'Email', bbox: { x: 0, y: 0, width: 200, height: 30 }, visible: true, enabled: true },
        { id: 'password', tag: 'input', inputType: 'password', ariaLabel: 'Password', bbox: { x: 0, y: 40, width: 200, height: 30 }, visible: true, enabled: true },
        { id: 'login-btn', tag: 'button', text: 'Log in', role: 'button', bbox: { x: 0, y: 80, width: 100, height: 30 }, visible: true, enabled: true }
    ];

    // The plan legitimately logs in, then wrongly aims the task text at the
    // email field.  Rejecting the whole plan would throw away the login steps.
    const queued = loop._queuePlan([
        { type: 'type_local', target: 'email', args: { secret_ref: 'email' } },
        { type: 'type_local', target: 'password', args: { secret_ref: 'password' } },
        { type: 'click', target: 'login-btn', args: {} },
        { type: 'type_local', target: 'email', args: { text: 'Study Cpp' } },
        { type: 'done', target: '', args: {} }
    ], dom, 'server', { reason: 'test' });

    assert.strictEqual(queued.accepted, true, 'the valid login steps must survive');
    const summary = loop._pendingPlan.actions
        .map(action => `${action.type}->${action.target}`)
        .join(',');
    assert.ok(!summary.includes('type_local->email:Study Cpp'));
    assert.ok(!loop._pendingPlan.actions.some(action =>
        action.type === 'type_local' &&
        action.target === 'email' &&
        action.args?.text
    ), 'task text must never target the email field');
    assert.ok(loop._pendingPlan.actions.some(a => a.type === 'click' && a.target === 'login-btn'));
    assert.ok(updates.some(u => /Blocked task text/i.test(u.log || '')));
});

test('a federated sign-in click is dropped while a local login form exists', () => {
    // Regression: the agent kept clicking "Sign in with Apple".  That control
    // hands authentication to a third party and cannot complete with the
    // credentials held locally, so the click is refused even when a backend
    // plan proposes it.
    const loop = new AgentLoop(32, 'Login and task "Study Cpp"');
    const updates = [];
    loop.running = true;
    loop._generation = 0;
    loop._broadcast = update => updates.push(update);
    const dom = [
        { id: 'sso-google', tag: 'button', role: 'button', text: 'Continue with Google', ariaLabel: 'Continue with Google', bbox: { x: 0, y: 0, width: 200, height: 30 }, visible: true, enabled: true },
        { id: 'sso-apple', tag: 'button', role: 'button', text: 'Sign in with Apple', ariaLabel: 'Sign in with Apple', bbox: { x: 0, y: 40, width: 200, height: 30 }, visible: true, enabled: true },
        { id: 'email', tag: 'input', inputType: 'email', autocomplete: 'email', placeholder: 'Enter your email...', bbox: { x: 0, y: 100, width: 200, height: 30 }, visible: true, enabled: true },
        { id: 'password', tag: 'input', inputType: 'password', autocomplete: 'current-password', placeholder: 'Enter your password...', bbox: { x: 0, y: 140, width: 200, height: 30 }, visible: true, enabled: true },
        { id: 'submit', tag: 'button', role: 'button', bbox: { x: 0, y: 180, width: 200, height: 30 }, visible: true, enabled: true }
    ];

    const queued = loop._queuePlan([
        { type: 'type_local', target: 'email', args: { secret_ref: 'email' } },
        { type: 'type_local', target: 'password', args: { secret_ref: 'password' } },
        { type: 'click', target: 'sso-apple', args: {} },
        { type: 'click', target: 'submit', args: {} }
    ], dom, 'server', { reason: 'test' });

    assert.strictEqual(queued.accepted, true);
    const targets = loop._pendingPlan.actions.map(action => action.target);
    assert.ok(!targets.includes('sso-apple'), 'a third-party sign-in button must never be clicked');
    assert.ok(!targets.includes('sso-google'));
    assert.ok(targets.includes('submit'), 'the real submit step must survive');
    assert.ok(updates.some(u => /third-party sign-in/i.test(u.log || '')));
});

test('a federated click is allowed when the page has no local credential form', () => {
    // On a page whose only path is a social provider, blocking it would make
    // the goal impossible.  The guard applies only alongside a local form.
    const loop = new AgentLoop(33, 'log in');
    loop.running = true;
    loop._generation = 0;
    loop._broadcast = () => {};
    const dom = [
        { id: 'sso-google', tag: 'button', role: 'button', text: 'Continue with Google', bbox: { x: 0, y: 0, width: 200, height: 30 }, visible: true, enabled: true }
    ];
    const queued = loop._queuePlan([
        { type: 'click', target: 'sso-google', args: {} }
    ], dom, 'server', { reason: 'test' });

    assert.strictEqual(queued.accepted, true);
    assert.ok(loop._pendingPlan.actions.some(a => a.type === 'click' && a.target === 'sso-google'));
});

test('"log in with email" is treated as a local path, not a provider', () => {
    const loop = new AgentLoop(34, 'log in');
    loop.running = true;
    loop._generation = 0;
    loop._broadcast = () => {};
    const dom = [
        { id: 'email', tag: 'input', inputType: 'email', autocomplete: 'email', placeholder: 'Email', bbox: { x: 0, y: 0, width: 200, height: 30 }, visible: true, enabled: true },
        { id: 'pw', tag: 'input', inputType: 'password', autocomplete: 'current-password', placeholder: 'Password', bbox: { x: 0, y: 40, width: 200, height: 30 }, visible: true, enabled: true },
        { id: 'tab-email', tag: 'button', role: 'button', text: 'Log in with email', bbox: { x: 0, y: 80, width: 200, height: 30 }, visible: true, enabled: true }
    ];
    const queued = loop._queuePlan([
        { type: 'click', target: 'tab-email', args: {} }
    ], dom, 'server', { reason: 'test' });

    assert.strictEqual(queued.accepted, true);
    assert.ok(loop._pendingPlan.actions.some(a => a.type === 'click' && a.target === 'tab-email'));
});

test('a create click is not blocked while the task text is staged', () => {
    // Regression: the guard against duplicate creates compared only "was this
    // control already clicked".  Committing a staged task is the same click, so
    // the run was killed with the task typed but never saved.
    const loop = new AgentLoop(35, 'Login and task "Study Cpp"');
    loop.running = true;
    loop._generation = 0;
    loop._broadcast = () => {};
    const dom = [
        { id: 'add', tag: 'button', role: 'button', ariaLabel: 'Add task', bbox: { x: 0, y: 0, width: 32, height: 32 }, visible: true, enabled: true },
        { id: 'comp', tag: 'div', role: 'textbox', inputType: 'contenteditable', text: 'Study Cpp', ariaLabel: 'Task title', bbox: { x: 40, y: 0, width: 400, height: 32 }, visible: true, enabled: true }
    ];
    const plan = [{ type: 'click', target: 'add', args: {} }];
    // Pretend the same create control was already clicked to open the composer.
    loop._executedCreateKeys.add(loop._createActionKey(plan[0], dom));

    assert.strictEqual(loop._shouldBlockRepeatedCreate(plan, dom), false,
        'committing a staged task must not be treated as a duplicate create');
});

test('an unstaged repeated create is still blocked', () => {
    // The original protection must survive: with no text in any task field,
    // clicking create again would only produce unnamed duplicates.
    const loop = new AgentLoop(36, 'Login and task "Study Cpp"');
    loop.running = true;
    loop._generation = 0;
    loop._broadcast = () => {};
    const dom = [
        { id: 'add', tag: 'button', role: 'button', ariaLabel: 'Add task', bbox: { x: 0, y: 0, width: 32, height: 32 }, visible: true, enabled: true }
    ];
    const plan = [{ type: 'click', target: 'add', args: {} }];
    loop._executedCreateKeys.add(loop._createActionKey(plan[0], dom));

    assert.strictEqual(loop._shouldBlockRepeatedCreate(plan, dom), true);
});

test('a done-only plan is accepted when the requested result is already present', async () => {
    // Regression: the final cycle of a create flow legitimately reports "done"
    // with nothing left to execute.  That was rejected as a planner error, so
    // the run ended in a red error state despite the task existing.
    const loop = new AgentLoop(37, 'Login and task "Study Cpp"');
    const updates = [];
    loop.running = true;
    loop._generation = 0;
    loop._sleep = async () => {};
    loop._broadcast = u => updates.push(u);
    const dom = [
        { id: 't-new', tag: 'div', role: 'listitem', text: 'Study Cpp', bbox: { x: 0, y: 0, width: 400, height: 32 }, visible: true, enabled: true }
    ];
    loop._observeDom = async () => dom;
    loop._pendingPlan = {
        actions: [{ type: 'done', target: '', args: {} }],
        index: 0,
        source: 'local',
        actionsExecuted: 0,
        meaningfulActionsExecuted: 0,
        expectedText: 'Study Cpp',
        mutation: true
    };

    const handled = await loop._executePendingPlan(dom, 0, Date.now(), {});

    assert.strictEqual(handled, true);
    const final = updates[updates.length - 1];
    assert.strictEqual(final.status, 'done', 'an already-satisfied goal must not be reported as an error');
    assert.strictEqual(loop.running, false);
});

test('a done-only plan is still rejected when the result is absent', async () => {
    // The protection must survive: reporting done with nothing executed and
    // nothing visible would let a stalled run pass as success.
    const loop = new AgentLoop(38, 'Login and task "Study Cpp"');
    const updates = [];
    loop.running = true;
    loop._generation = 0;
    loop._sleep = async () => {};
    loop._broadcast = u => updates.push(u);
    const dom = [
        { id: 't-1', tag: 'div', role: 'listitem', text: 'Buy milk', bbox: { x: 0, y: 0, width: 400, height: 32 }, visible: true, enabled: true }
    ];
    loop._observeDom = async () => dom;
    loop._pendingPlan = {
        actions: [{ type: 'done', target: '', args: {} }],
        index: 0,
        source: 'local',
        actionsExecuted: 0,
        meaningfulActionsExecuted: 0,
        expectedText: 'Study Cpp',
        mutation: true
    };

    await loop._executePendingPlan(dom, 0, Date.now(), {});
    const final = updates[updates.length - 1];
    assert.strictEqual(final.status, 'error');
    assert.match(final.error, /without executing an action/i);
});

test('task text aimed at a search field is dropped', () => {
    const loop = new AgentLoop(31, 'add a task named "GOC"');
    loop.running = true;
    loop._generation = 0;
    loop._broadcast = () => {};
    const dom = [
        { id: 'search-box', tag: 'input', inputType: 'text', role: 'searchbox', placeholder: 'Search', ariaLabel: 'Search', bbox: { x: 0, y: 0, width: 200, height: 30 }, visible: true, enabled: true },
        { id: 'add-task-btn', tag: 'button', text: 'Add task', role: 'button', bbox: { x: 0, y: 40, width: 100, height: 30 }, visible: true, enabled: true }
    ];

    const queued = loop._queuePlan([
        { type: 'type_local', target: 'search-box', args: { text: 'GOC' } },
        { type: 'click', target: 'add-task-btn', args: {} },
        { type: 'done', target: '', args: {} }
    ], dom, 'server', { reason: 'test' });

    assert.strictEqual(queued.accepted, true);
    assert.ok(!loop._pendingPlan.actions.some(action => action.target === 'search-box'),
        'a search box is not a task composer');
    assert.ok(loop._pendingPlan.actions.some(a => a.type === 'click' && a.target === 'add-task-btn'));
});

test('rejects a terminal done plan when no action was executed', async () => {
    const loop = new AgentLoop(11, 'add a task named "GOC"');
    const updates = [];
    loop.running = true;
    loop._generation = 0;
    loop._broadcast = update => updates.push(update);
    const queued = loop._queuePlan([
        { type: 'done', target: '', args: {} }
    ], [], 'server', { reason: 'test' });
    assert.strictEqual(queued.accepted, true);
    await loop._executePendingPlan([], 0, performance.now(), {});
    assert.strictEqual(loop.running, false);
    assert.ok(updates.some(update =>
        update.status === 'error' && /without executing an action/i.test(update.error || '')
    ));
});

test('rejects a wait-only plan that cannot accomplish the goal', () => {
    const loop = new AgentLoop(21, 'add a task named "GOC"');
    loop.running = true;
    loop._generation = 0;
    loop._broadcast = () => {};
    const queued = loop._queuePlan([
        { type: 'wait', target: '', args: { ms: 500, reason: 'VLM Error' } }
    ], [], 'server', { reason: 'provider error' });
    assert.deepStrictEqual(queued, { accepted: false, blocked: false });
    assert.strictEqual(loop._pendingPlan, null);
});

test('an unavailable backend stops with an actionable error instead of waiting', async () => {
    const loop = new AgentLoop(22, 'add a task named "GOC"');
    const updates = [];
    loop.running = true;
    loop._generation = 0;
    loop._sleep = async () => {};
    loop._broadcast = update => updates.push(update);
    loop._scheduleNextCycle = () => {};
    loop.client.plan = async () => ({
        success: false,
        error: 'The configured planner provider is unavailable',
        providerError: true
    });
    // Force the server tier so local planning cannot mask the backend failure.
    loop.localAgent.analyze = () => ({ decision: 'SERVER', reason: 'not visible yet', actions: [] });
    loop.localVisionAgent = { shouldAttempt: () => false, dispose: () => {} };
    loop._sendToContent = async (type) => {
        if (type === 'ANALYZE_DOM') return { elements: [], route: '' };
        if (type === 'PRIVACY_PIPELINE') return observedContext();
        return null;
    };

    // _backoff re-enters _cycle, so a single await drains the bounded retries.
    await loop._cycle(0);

    assert.strictEqual(loop._consecutiveBackendFailures, 3);
    assert.strictEqual(loop.running, false);
    assert.strictEqual(loop._totalMeaningfulActionsExecuted, 0);
    assert.ok(updates.some(update =>
        update.status === 'error' && /planner backend is unavailable/i.test(update.error || '')
    ), 'expected an actionable backend error');
    assert.ok(!updates.some(update =>
        update.actionsExecuted === 1 && !update.actions
    ), 'a provider failure must never be reported as an executed action');
});

test('agent loop stops instead of replaying an unchanged non-terminal plan', async () => {
    const loop = new AgentLoop(7, 'add a task named "Run"');
    const updates = [];
    let planCalls = 0;
    let executeCalls = 0;

    loop.client.plan = async () => {
        planCalls++;
        return {
            success: true,
            actions: [{ type: 'click', target: 'add-task', args: {} }]
        };
    };
    loop._sendToContent = async (type) => {
        if (type === 'PRIVACY_PIPELINE') return observedContext();
        if (type === 'EXECUTE_VALIDATED_ACTION') {
            executeCalls++;
            return { success: true };
        }
        return null;
    };
    loop._broadcast = update => updates.push(update);
    loop._sleep = async () => {};
    loop.running = true;
    loop._generation = 0;

    const scheduled = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback) => {
        scheduled.push(callback);
        return scheduled.length;
    };

    try {
        await loop._cycle(0);
        assert.strictEqual(planCalls, 1);
        assert.strictEqual(executeCalls, 1);
        assert.strictEqual(scheduled.length, 1);

        await scheduled[0]();

        assert.strictEqual(planCalls, 2);
        assert.strictEqual(executeCalls, 1, 'the duplicate plan must not execute twice');
        assert.strictEqual(loop.running, false);
        assert.ok(updates.some(update =>
            update.status === 'error' &&
            update.log && (/repeated (create-only )?plan/i.test(update.log) || /create attempt/i.test(update.log))
        ));
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }
});

/**
 * A search page that grows a result set as the loop works: an empty query box
 * with navigation around it, the same page once the query is typed, a result
 * list once the search is submitted, and finally the destination the first
 * result leads to.  Navigation rows are modelled at the top and the bottom of
 * the page, because a page's own menus sit below the query box too.
 */
/**
 * A search driven end to end against the shape google.com actually ships: a
 * bare <textarea role="combobox" name="q" aria-label="Search"> for the query and
 * <input type="submit"> buttons labelled "Google Search" beside it.  The goal is
 * deliberately unquoted, because a quoted query never reaches the engine-name
 * handling and hid that bug from this flow.
 */
function createSearchFlow(goal = 'search google for cpp tutorial and open the first result') {
    const box = (x, y, width, height) => ({ x, y, width: width, height });
    const node = values => ({ visible: true, enabled: true, ...values });
    const link = (id, text, y, x = 120) =>
        node({ id, tag: 'a', role: 'link', text, bbox: box(x, y, 400, 20) });
    const navRun = (prefix, y) => [
        link(`${prefix}1`, 'Images', y, 120),
        link(`${prefix}2`, 'Videos', y, 200),
        link(`${prefix}3`, 'News', y, 275),
        link(`${prefix}4`, 'Maps', y, 340)
    ];
    // The real query box: no searchbox role, no placeholder, and a "textarea"
    // inputType because dom_analyzer reads element.type off a textarea.
    const searchBox = text => node({
        id: 'ti6dpd', tag: 'textarea', role: 'combobox', name: 'q', inputType: 'textarea',
        ariaLabel: 'Search', placeholder: '', autocomplete: 'off',
        bbox: box(120, 100, 600, 44), ...(text ? { text } : {})
    });
    // Buttons that say "search" but cannot hold text.  Google's desktop and
    // mobile markup ship together, so each one is present twice.
    const submit = (name, ariaLabel) => node({
        id: '', tag: 'input', role: 'button', name, inputType: 'submit', ariaLabel,
        bbox: box(600, 100, 40, 40)
    });
    const chrome = [
        node({ id: '', tag: 'input', role: '', inputType: 'file', bbox: box(10, 10, 20, 20) }),
        submit('btnK', 'Google Search'),
        submit('btnI', "I'm Feeling Lucky"),
        submit('btnK', 'Google Search'),
        submit('btnI', "I'm Feeling Lucky"),
        node({ id: '', tag: 'input', role: '', inputType: 'hidden', name: 'sca_esv', bbox: box(0, 0, 0, 0) }),
        node({ id: '', tag: 'input', role: '', inputType: 'hidden', name: 'sxsrf', bbox: box(0, 0, 0, 0) })
    ];

    const pages = {
        HOME: [searchBox(''), ...chrome, ...navRun('h', 200), ...navRun('f', 900)],
        TYPED: [searchBox('cpp tutorial'), ...chrome, ...navRun('h', 200), ...navRun('f', 900)],
        RESULTS: [
            searchBox('cpp tutorial'),
            ...chrome,
            ...navRun('h', 200),
            link('r1', 'The C++ programming language - cppreference', 280),
            link('r2', 'C++ Tutorial - W3Schools', 360),
            link('r3', 'Learn C++ - freeCodeCamp', 440),
            ...navRun('f', 900)
        ],
        OPENED: [node({
            id: 'title', tag: 'h1', role: 'heading',
            text: 'The C++ programming language', bbox: box(100, 60, 700, 40)
        })]
    };

    const state = { page: 'HOME', executed: [], updates: [], backendCalls: 0 };

    state.advance = action => {
        if (state.page === 'HOME' && action.type === 'type_local') {
            state.page = 'TYPED';
            return;
        }
        if (state.page === 'TYPED' && action.type === 'keypress') {
            state.page = 'RESULTS';
            return;
        }
        if (action.type === 'click' && action.target === 'r1') {
            state.page = 'OPENED';
        }
    };

    const loop = new AgentLoop(41, goal);
    state.loop = loop;
    loop.client.plan = async () => {
        state.backendCalls++;
        throw new Error('the local planner must resolve a search on its own');
    };
    loop._sleep = async () => {};
    loop._broadcast = update => state.updates.push(update);
    loop._sendToContent = async (type, payload = {}) => {
        if (type === 'ANALYZE_DOM') return { elements: pages[state.page] };
        if (type === 'PRIVACY_PIPELINE') {
            return {
                allowed: true,
                sanitizedContext: {
                    goal: loop.goal,
                    page: { url: 'https://search.test/', title: 'Search', viewport: { width: 1280, height: 900 } },
                    dom: pages[state.page],
                    image: 'data:image/jpeg;base64,redacted'
                },
                redactionPlan: []
            };
        }
        if (type === 'EXECUTE_VALIDATED_ACTION') {
            state.executed.push(payload.action);
            state.advance(payload.action);
            return { success: true };
        }
        return null;
    };

    loop.running = true;
    loop._generation = 0;
    state.run = async (maxCycles = 14) => {
        for (let cycle = 0; cycle < maxCycles && loop.running; cycle++) {
            await loop._cycle(loop._generation);
        }
        return state;
    };
    state.finalUpdate = () => state.updates[state.updates.length - 1] ?? {};
    return state;
}

test('a full search then open-first-result flow reaches done without the backend', async () => {
    const flow = createSearchFlow();
    await flow.run();

    assert.strictEqual(flow.page, 'OPENED', 'the first result must be opened by the end of the run');
    assert.strictEqual(flow.loop.running, false);
    assert.strictEqual(flow.backendCalls, 0, 'no request may reach the backend for this flow');
    assert.strictEqual(flow.finalUpdate().status, 'done',
        `run ended as ${flow.finalUpdate().status}: ${flow.finalUpdate().error || ''}`);

    const typed = flow.executed.filter(action => action.type === 'type_local');
    assert.deepStrictEqual(typed.map(action => [action.target, action.args.text]), [['ti6dpd', 'cpp tutorial']],
        'the query is typed once, into the search field, without the engine name');
    assert.strictEqual(flow.executed.filter(action => action.type === 'keypress').length, 1,
        'the search is submitted exactly once');
    assert.ok(flow.executed.some(action => action.type === 'click' && action.target === 'r1'),
        'the first result is clicked');
    assert.ok(!flow.executed.some(action => /^(?:h|f)\d$/.test(String(action.target))),
        'a navigation row must never be clicked as if it were a result');
});

/**
 * A login page that turns into a task list, a composer, a filled composer and
 * finally a created task, advancing as the loop executes actions.  This is the
 * demo path expressed as a page a single page app would really produce.
 */
function createLoginCreateFlow() {
    const box = (x, y, width, height) => ({ x, y, width, height });
    const node = values => ({ visible: true, enabled: true, ...values });

    const LOGIN = [
        node({ id: 'sso-google', tag: 'button', role: 'button', ariaLabel: 'Continue with Google', bbox: box(360, 200, 280, 44) }),
        node({ id: 'sso-apple', tag: 'button', role: 'button', ariaLabel: 'Sign in with Apple', bbox: box(360, 252, 280, 44) }),
        node({ id: 'email', tag: 'input', role: 'textbox', inputType: 'email', autocomplete: 'email', placeholder: 'Enter your email...', bbox: box(360, 370, 280, 44) }),
        node({ id: 'password', tag: 'input', role: 'textbox', inputType: 'password', autocomplete: 'current-password', placeholder: 'Enter your password...', bbox: box(360, 430, 280, 44) }),
        node({ id: 'submit', tag: 'button', role: 'button', bbox: box(660, 372, 44, 40) })
    ];
    const LIST = [
        node({ id: 'search', tag: 'input', role: 'searchbox', inputType: 'text', placeholder: 'Search', bbox: box(1100, 20, 160, 32) }),
        node({ id: 'inbox', tag: 'a', role: 'link', text: 'Inbox', bbox: box(0, 60, 200, 30) }),
        node({ id: 'add', tag: 'button', role: 'button', ariaLabel: 'Add task', bbox: box(240, 70, 32, 32) }),
        node({ id: 'task-1', tag: 'div', role: 'listitem', text: 'Buy milk', bbox: box(240, 120, 700, 44) })
    ];
    const pages = {
        LOGIN,
        LIST,
        COMPOSER: [
            ...LIST,
            node({ id: 'composer', tag: 'div', role: 'textbox', inputType: 'contenteditable', ariaLabel: 'Task title', placeholder: 'Task title', bbox: box(240, 70, 700, 40) })
        ],
        FILLED: [
            ...LIST,
            node({ id: 'composer', tag: 'div', role: 'textbox', inputType: 'contenteditable', text: 'Study Cpp', ariaLabel: 'Task title', bbox: box(240, 70, 700, 40) })
        ],
        CREATED: [
            ...LIST,
            node({ id: 'task-new', tag: 'div', role: 'listitem', text: 'Study Cpp', bbox: box(240, 120, 700, 44) })
        ]
    };

    const state = {
        page: 'LOGIN',
        executed: [],
        updates: [],
        backendCalls: 0,
        // Number of upcoming ANALYZE_DOM messages that get no answer, which is
        // what a tab looks like while its document is being replaced.
        refusedObservations: 0,
        refusalsServed: 0,
        // Browser-reported tab status, so a slow-booting page can be modelled.
        tabStatus: 'complete',
        loop: null
    };

    state.advance = action => {
        if (state.page === 'LOGIN' && action.type === 'click' && action.target === 'submit') {
            state.page = 'LIST';
            return;
        }
        if (state.page === 'LIST' && action.type === 'click' && action.target === 'add') {
            state.page = 'COMPOSER';
            return;
        }
        if (state.page === 'COMPOSER' && action.type === 'type_local') {
            state.page = 'FILLED';
            return;
        }
        if (state.page === 'FILLED' && action.type === 'click' && action.target === 'add') {
            state.page = 'CREATED';
        }
    };

    const loop = new AgentLoop(40, 'Login and task "Study Cpp"');
    state.loop = loop;
    loop.client.plan = async () => {
        state.backendCalls++;
        throw new Error('the local planner must resolve this flow on its own');
    };
    loop._sleep = async () => {};
    loop._broadcast = update => state.updates.push(update);

    // Drive the real send path through a fake extension transport so refusal
    // detection is exercised rather than simulated.  Returning REFUSED models a
    // document that has been replaced and has no receiver attached yet.
    const REFUSED = Symbol('refused');
    state.REFUSED = REFUSED;
    state.handle = message => {
        if (message.type === 'ANALYZE_DOM') {
            if (state.refusedObservations > 0) {
                state.refusedObservations--;
                state.refusalsServed++;
                return REFUSED;
            }
            return { elements: pages[state.page] };
        }
        if (message.type === 'PRIVACY_PIPELINE') {
            return {
                allowed: true,
                sanitizedContext: {
                    goal: loop.goal,
                    page: { url: 'https://app.todoist.test/app/today', title: 'Today', viewport: { width: 1280, height: 900 } },
                    dom: pages[state.page],
                    image: 'data:image/jpeg;base64,redacted'
                },
                redactionPlan: []
            };
        }
        if (message.type === 'EXECUTE_VALIDATED_ACTION') {
            state.executed.push(message.action);
            state.advance(message.action);
            return { success: true };
        }
        return null;
    };

    const transport = {
        runtime: { lastError: undefined },
        tabs: {
            sendMessage: (tabId, message, callback) => {
                const response = state.handle(message);
                if (response === REFUSED) {
                    transport.runtime.lastError = {
                        message: 'Could not establish connection. Receiving end does not exist.'
                    };
                    callback(undefined);
                    transport.runtime.lastError = undefined;
                    return;
                }
                transport.runtime.lastError = undefined;
                callback(response);
            },
            get: (tabId, callback) => {
                transport.runtime.lastError = undefined;
                callback({ id: tabId, status: state.tabStatus || 'complete' });
            }
        }
    };
    state.installTransport = () => {
        state.originalChrome = globalThis.chrome;
        globalThis.chrome = transport;
    };
    state.restoreTransport = () => {
        if (state.originalChrome === undefined) delete globalThis.chrome;
        else globalThis.chrome = state.originalChrome;
    };
    state.installTransport();

    loop.running = true;
    loop._generation = 0;

    // The generation moves when navigation resumes the run, so each cycle is
    // driven with the current one rather than a captured value.
    state.run = async (maxCycles = 14) => {
        for (let cycle = 0; cycle < maxCycles && loop.running; cycle++) {
            await loop._cycle(loop._generation);
        }
        state.restoreTransport();
        return state;
    };
    state.finalUpdate = () => state.updates[state.updates.length - 1] ?? {};
    return state;
}

test('a full login then create flow reaches done without calling the backend', async () => {
    const flow = createLoginCreateFlow();
    await flow.run();

    assert.strictEqual(flow.page, 'CREATED', 'the task must exist by the end of the run');
    assert.strictEqual(flow.loop.running, false);
    assert.strictEqual(flow.backendCalls, 0, 'no request may reach the backend for this flow');
    assert.strictEqual(flow.finalUpdate().status, 'done',
        `run ended as ${flow.finalUpdate().status}: ${flow.finalUpdate().error || ''}`);

    const typed = flow.executed.filter(action => action.type === 'type_local');
    assert.strictEqual(typed.length, 3, 'email, password and the task text are typed locally');
    assert.strictEqual(typed.at(-1).args.text, 'Study Cpp');
    assert.ok(
        !flow.executed.some(action => action.type === 'type_local' && /sso-|submit/.test(action.target)),
        'task text must never be aimed at a sign-in control'
    );
});

test('a page swap after login is waited out and the task is still added', async () => {
    // Regression: the login navigation detaches the content script, and the
    // refused message was treated as fatal, so the run died on arrival at the
    // task list instead of continuing onto it.
    const flow = createLoginCreateFlow();
    const originalHandle = flow.handle;
    let armed = false;
    flow.handle = message => {
        // The real tab refuses every message for a few probes, once, as the
        // login click takes effect and the document is replaced.
        if (!armed && message.type === 'ANALYZE_DOM' && flow.page === 'LIST') {
            armed = true;
            flow.refusedObservations = 4;
        }
        return originalHandle(message);
    };
    await flow.run();

    assert.ok(flow.refusalsServed > 0, 'the swap must actually have been exercised');
    assert.strictEqual(flow.page, 'CREATED', 'the task must still be added after the reload');
    assert.ok(
        !flow.updates.some(update => /Content script not responding/.test(update.error || '')),
        'a navigation must never be reported as an unreachable content script'
    );
    assert.strictEqual(flow.finalUpdate().status, 'done',
        `run ended as ${flow.finalUpdate().status}: ${flow.finalUpdate().error || ''}`);
});

test('a slow-booting page is waited on while the tab still reports loading', async () => {
    // A heavy app can take well over the first bound to attach its content
    // script.  The tab reporting "loading" is what distinguishes that from a
    // page that simply stopped answering.
    const flow = createLoginCreateFlow();
    const originalHandle = flow.handle;
    let armed = false;
    flow.handle = message => {
        if (!armed && message.type === 'ANALYZE_DOM' && flow.page === 'LIST') {
            armed = true;
            // Stay refused well past the base bound, then come back.
            flow.refusedObservations = 14;
        }
        return originalHandle(message);
    };
    flow.tabStatus = 'loading';
    const originalSleep = flow.loop._sleep;
    let elapsed = 0;
    flow.loop._sleep = async ms => { elapsed += ms; };
    try {
        await flow.run();
    } finally {
        flow.loop._sleep = originalSleep;
    }

    assert.ok(elapsed > 10000, `expected a long wait, got ${elapsed}ms`);
    assert.strictEqual(flow.page, 'CREATED', 'a slow page must not fail the run');
    assert.strictEqual(flow.finalUpdate().status, 'done',
        `run ended as ${flow.finalUpdate().status}: ${flow.finalUpdate().error || ''}`);
});

test('a tab that never answers still reports the unreachable content script', async () => {
    // The bound must still hold: a page that can never be reached has to fail
    // closed with the original message rather than wait forever.
    const flow = createLoginCreateFlow();
    flow.refusedObservations = Number.MAX_SAFE_INTEGER;
    await flow.run(2);

    const final = flow.finalUpdate();
    assert.strictEqual(final.status, 'error');
    assert.match(final.error, /Content script not responding/);
    assert.strictEqual(flow.loop.running, false);
});

test('a reachable content script with no controls still escalates', async () => {
    // The opposite of a navigation: a page that answers but exposes nothing
    // must keep escalating as before, not be mistaken for a page swap.
    const loop = new AgentLoop(41, 'add a task named "Run"');
    const updates = [];
    let planCalls = 0;
    loop.client.plan = async () => {
        planCalls++;
        return { success: true, actions: [{ type: 'done', target: '', args: {} }] };
    };
    loop._sendToContent = async type => (type === 'PRIVACY_PIPELINE' ? observedContext() : { elements: [] });
    loop._broadcast = update => updates.push(update);
    loop._sleep = async () => {};
    loop.running = true;
    loop._generation = 0;

    await loop._cycle(0);
    assert.strictEqual(planCalls, 1, 'an empty but reachable page must still reach the backend');
    assert.ok(!updates.some(update => /Content script not responding/.test(update.error || '')));
});

test('an action refused by a page swap is re-planned, not reported as failed', async () => {
    // The document can also be replaced between observing and acting.  Nothing
    // received the action, so it never ran, and the run has to continue on the
    // new page instead of ending on a phantom failure.
    const flow = createLoginCreateFlow();
    const originalHandle = flow.handle;
    let armed = false;
    flow.handle = message => {
        // Refuse the one action that follows the login click.
        if (!armed && message.type === 'EXECUTE_VALIDATED_ACTION') {
            armed = true;
            flow.refusalsServed++;
            return flow.REFUSED;
        }
        return originalHandle(message);
    };
    await flow.run();

    assert.ok(armed, 'a refused action must actually have been exercised');
    assert.strictEqual(flow.page, 'CREATED', 'the task must still be added');
    assert.ok(
        !flow.updates.some(update => /no response|Action failed/.test(update.log || '')),
        'an undelivered action must not be reported as a failed action'
    );
    assert.strictEqual(flow.finalUpdate().status, 'done',
        `run ended as ${flow.finalUpdate().status}: ${flow.finalUpdate().error || ''}`);
});

test('a page-load resume during the wait is not overwritten by a failure', async () => {
    // The page-load event and the in-place wait race.  When the event wins it
    // bumps the generation to resume the run, and the wait must stand down
    // rather than declare the tab unreachable over its shoulder.
    const flow = createLoginCreateFlow();
    const loop = flow.loop;
    flow.handle = () => {
        // Stand in for the onUpdated('complete') listener resuming the run.
        loop._generation += 1;
        return null;
    };
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = () => 0;
    try {
        loop.running = true;
        await loop._cycle(loop._generation);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        flow.restoreTransport();
    }

    assert.ok(loop.running, 'a concurrent resume must not end the run');
    assert.ok(
        !loop._lastCycleFailed,
        'the stand-down cycle must not be recorded as a failure'
    );
});

