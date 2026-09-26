import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LocalAgent } from '../extension/background/local_agent.js';
import { AgentLoop } from '../extension/background/agent_loop.js';
import { validateActionPlan } from '../extension/background/api_client.js';

function node(id, tag, values = {}) {
    return {
        id,
        tag,
        role: '',
        text: '',
        inputType: '',
        autocomplete: '',
        placeholder: '',
        ariaLabel: '',
        name: '',
        label: '',
        options: [],
        bbox: { x: 0, y: 0, width: 200, height: 32 },
        visible: true,
        enabled: true,
        ...values
    };
}

function pageElements() {
    return [
        node('submit', 'button', { text: 'Submit' }),
        node('email', 'input', { inputType: 'email', placeholder: 'Email' }),
        node('title', 'input', { placeholder: 'Task title' }),
        node('password', 'input', { inputType: 'password', placeholder: 'Password' })
    ];
}

function context(elements) {
    return {
        allowed: true,
        sanitizedContext: {
            goal: 'local task',
            page: {
                url: 'https://example.test/tasks',
                title: 'Tasks',
                viewport: { width: 100, height: 100 }
            },
            dom: elements,
            image: 'data:image/jpeg;base64,redacted'
        },
        redactionPlan: []
    };
}

async function runLocalLoop(goal, elements = pageElements()) {
    const loop = new AgentLoop(7, goal);
    const updates = [];
    const executed = [];
    let backendCalls = 0;
    let privacyCalls = 0;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        fetchCalls++;
        throw new Error('network should not be used');
    };

    loop.client.plan = async () => {
        backendCalls++;
        return { success: true, actions: [{ type: 'done', target: '', args: {} }] };
    };
    loop._sendToContent = async (type, payload = {}) => {
        if (type === 'ANALYZE_DOM') return { elements };
        if (type === 'PRIVACY_PIPELINE') {
            privacyCalls++;
            return context(elements);
        }
        if (type === 'EXECUTE_VALIDATED_ACTION') {
            executed.push(payload.action);
            return { success: true };
        }
        return null;
    };
    loop._broadcast = update => updates.push(update);
    loop._sleep = async () => {};
    loop.running = true;
    loop._generation = 0;

    try {
        await loop._cycle(0);
    } finally {
        globalThis.fetch = originalFetch;
    }
    return { loop, updates, executed, backendCalls, privacyCalls, fetchCalls };
}

describe('Local offline agent', () => {
    test('solves a named visible click locally', () => {
        const result = new LocalAgent().analyze('click the submit button', pageElements());
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions.map(action => action.type), ['click', 'done']);
        assert.strictEqual(result.actions[0].target, 'submit');
    });

    test('solves a named focus task locally', () => {
        const result = new LocalAgent().analyze('focus the email field', pageElements());
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions.map(action => action.type), ['focus', 'done']);
        assert.strictEqual(result.actions[0].target, 'email');
    });

    test('solves scroll locally', () => {
        const result = new LocalAgent().analyze('scroll down', pageElements());
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions[0], {
            type: 'scroll',
            target: 'body',
            args: { x: 0, y: 600 }
        });
    });

    test('opens a named link or menu locally', () => {
        const elements = [...pageElements(), node('account-menu', 'a', { text: 'Account menu' })];
        const result = new LocalAgent().analyze('open the account menu', elements);
        assert.strictEqual(result.decision, 'LOCAL');
        assert.strictEqual(result.actions[0].target, 'account-menu');
    });

    test('supports a short exact sequential form interaction', () => {
        const elements = [
            node('new-task', 'button', { text: 'New task' }),
            node('task-title', 'input', { placeholder: 'Task title' })
        ];
        const result = new LocalAgent().analyze(
            'click the new task button then type "Run" into the task title',
            elements
        );
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions.map(action => action.type), ['click', 'type_local', 'done']);
    });

    test('solves ordinary text typing locally when the field is explicit', () => {
        const result = new LocalAgent().analyze('type "Run" into the task title', pageElements());
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions[0], {
            type: 'type_local',
            target: 'title',
            args: { text: 'Run' }
        });
    });

    test('refuses ordinary text entry into an identity field', () => {
        const result = new LocalAgent().analyze('type "Study Cpp" into the email field', [
            node('email', 'input', { inputType: 'email', placeholder: 'Email' })
        ]);
        assert.notStrictEqual(result.decision, 'LOCAL');
        assert.ok(!result.actions.some(action => action.target === 'email'));
    });

    test('uses type_local for an allowed local secret', () => {
        const result = new LocalAgent().analyze('type my email into the email field', pageElements());
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions[0], {
            type: 'type_local',
            target: 'email',
            args: { secret_ref: 'email' }
        });
    });

    test('escalates complex tasks to the server', () => {
        const result = new LocalAgent().analyze('find the cheapest flight', pageElements());
        assert.strictEqual(result.decision, 'SERVER');
        assert.deepStrictEqual(result.actions, []);
        assert.match(result.reason, /complex/i);
    });

    test('escalates ambiguous targets to the server', () => {
        const elements = [
            node('submit-a', 'button', { text: 'Submit' }),
            node('submit-b', 'button', { text: 'Submit' })
        ];
        const result = new LocalAgent().analyze('click the submit button', elements);
        assert.strictEqual(result.decision, 'SERVER');
        assert.match(result.reason, /ambiguous|no exact/i);
    });

    test('local plans pass the same validator as server plans', () => {
        const result = new LocalAgent().analyze('click the submit button', pageElements());
        const validated = validateActionPlan(result.actions);
        assert.strictEqual(validated.ok, true);
        assert.deepStrictEqual(validated.actions, result.actions);
    });

    test('local success executes without privacy pipeline or backend requests', async () => {
        const result = await runLocalLoop('click the submit button');
        assert.strictEqual(result.backendCalls, 0);
        assert.strictEqual(result.fetchCalls, 0);
        assert.strictEqual(result.privacyCalls, 0);
        assert.deepStrictEqual(result.executed.map(action => action.type), ['click']);
        assert.strictEqual(result.loop.running, false);
        assert.ok(result.updates.some(update => update.source === 'local' && update.status === 'done'));
    });

    test('assigns a priority level through the revealed menu', () => {
        // Deliberately generic: no site-specific ids or selectors, only roles
        // and accessible names, so this applies to any task UI.
        const dom = [
            { id: 'row', tag: 'div', role: 'listitem', text: 'Study Cpp', bbox: { x: 0, y: 0, width: 300, height: 40 }, visible: true, enabled: true },
            { id: 'pri-ctl', tag: 'button', role: 'button', ariaLabel: 'Set priority for Study Cpp', bbox: { x: 300, y: 0, width: 30, height: 30 }, visible: true, enabled: true },
            { id: 'opt-1', tag: 'button', role: 'menuitemradio', text: 'Priority 1', ariaLabel: 'Priority 1', bbox: { x: 300, y: 50, width: 120, height: 30 }, visible: true, enabled: true },
            { id: 'opt-2', tag: 'button', role: 'menuitemradio', text: 'Priority 2', ariaLabel: 'Priority 2', bbox: { x: 300, y: 80, width: 120, height: 30 }, visible: true, enabled: true }
        ];
        const result = new LocalAgent().analyze('set priority 1 for the task', dom, {});
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions.map(a => `${a.type}->${a.target}`), ['click->opt-1', 'done->']);
    });

    test('opens the priority control first and stays non-terminal', () => {
        const dom = [
            { id: 'row', tag: 'div', role: 'listitem', text: 'Study Cpp', bbox: { x: 0, y: 0, width: 300, height: 40 }, visible: true, enabled: true },
            { id: 'pri-ctl', tag: 'button', role: 'button', ariaLabel: 'Set priority for Study Cpp', bbox: { x: 300, y: 0, width: 30, height: 30 }, visible: true, enabled: true }
        ];
        const result = new LocalAgent().analyze('set high priority to the task', dom, {});
        assert.strictEqual(result.decision, 'LOCAL');
        // No terminal marker: the menu is not visible yet, so claiming
        // completion here would report success without setting anything.
        assert.deepStrictEqual(result.actions.map(a => `${a.type}->${a.target}`), ['click->pri-ctl']);
    });

    test('does not guess a priority level when none was requested', () => {
        const dom = [
            { id: 'pri-ctl', tag: 'button', role: 'button', ariaLabel: 'Set priority for Study Cpp', bbox: { x: 300, y: 0, width: 30, height: 30 }, visible: true, enabled: true },
            { id: 'opt-1', tag: 'button', role: 'menuitemradio', text: 'Priority 1', bbox: { x: 300, y: 50, width: 120, height: 30 }, visible: true, enabled: true },
            { id: 'opt-2', tag: 'button', role: 'menuitemradio', text: 'Priority 2', bbox: { x: 300, y: 80, width: 120, height: 30 }, visible: true, enabled: true }
        ];
        const result = new LocalAgent().analyze('assign priority to task', dom, {});
        assert.strictEqual(result.decision, 'SERVER');
        assert.match(result.reason, /ambiguous/i);
    });

    test('picks the form submit over an identically labelled navigation link', () => {
        // Regression: a login page carrying both a header "Log in" link and a
        // form "Log in" button produced two submit candidates, so the whole
        // login was reported ambiguous and the agent stalled on the login page
        // waiting for a task composer that could never appear.
        const dom = [
            { id: 'nav-link', tag: 'a', role: 'link', text: 'Log in', bbox: { x: 1000, y: 24, width: 60, height: 24 }, visible: true, enabled: true },
            { id: 'google', tag: 'button', role: 'button', ariaLabel: 'Continue with Google', text: 'Continue with Google', bbox: { x: 460, y: 200, width: 360, height: 40 }, visible: true, enabled: true },
            { id: 'facebook', tag: 'button', role: 'button', ariaLabel: 'Continue with Facebook', text: 'Continue with Facebook', bbox: { x: 460, y: 250, width: 360, height: 40 }, visible: true, enabled: true },
            { id: 'email', tag: 'input', role: 'textbox', inputType: 'email', autocomplete: 'email', ariaLabel: 'Email address', bbox: { x: 460, y: 350, width: 360, height: 44 }, visible: true, enabled: true },
            { id: 'password', tag: 'input', role: 'textbox', inputType: 'password', autocomplete: 'current-password', ariaLabel: 'Password', bbox: { x: 460, y: 430, width: 360, height: 44 }, visible: true, enabled: true },
            { id: 'submit', tag: 'button', role: 'button', text: 'Log in', ariaLabel: 'Log in', bbox: { x: 460, y: 520, width: 360, height: 46 }, visible: true, enabled: true }
        ];
        const result = new LocalAgent().analyze('login', dom, {});
        assert.strictEqual(result.decision, 'LOCAL');
        // The real submit button, not the nav link and not a social provider.
        assert.deepStrictEqual(result.actions.map(a => `${a.type}->${a.target}`), [
            'type_local->email',
            'type_local->password',
            'click->submit',
            'done->'
        ]);
        // Credentials stay as local references, never plaintext.
        assert.deepStrictEqual(result.actions[0].args, { secret_ref: 'email' });
        assert.deepStrictEqual(result.actions[1].args, { secret_ref: 'password' });
    });

    test('executes the login prefix when the task composer is not mounted yet', () => {
        const dom = [
            { id: 'nav-link', tag: 'a', role: 'link', text: 'Log in', bbox: { x: 1000, y: 24, width: 60, height: 24 }, visible: true, enabled: true },
            { id: 'email', tag: 'input', role: 'textbox', inputType: 'email', autocomplete: 'email', ariaLabel: 'Email address', bbox: { x: 460, y: 350, width: 360, height: 44 }, visible: true, enabled: true },
            { id: 'password', tag: 'input', role: 'textbox', inputType: 'password', autocomplete: 'current-password', ariaLabel: 'Password', bbox: { x: 460, y: 430, width: 360, height: 44 }, visible: true, enabled: true },
            { id: 'submit', tag: 'button', role: 'button', text: 'Log in', ariaLabel: 'Log in', bbox: { x: 460, y: 520, width: 360, height: 46 }, visible: true, enabled: true }
        ];
        const result = new LocalAgent().analyze('Login and task "Study Cpp"', dom, {});
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions.map(a => `${a.type}->${a.target}`), [
            'type_local->email',
            'type_local->password',
            'click->submit'
        ]);
        // No terminal marker: the task clause still has to run after the
        // page changes, so the loop must re-observe rather than claim success.
        assert.ok(!result.actions.some(a => a.type === 'done'));
    });

    test('leaves the login submit ambiguous when two candidates truly tie', () => {
        // Two equally plausible buttons and no distinguishing signal: decline
        // rather than guess, so credentials are never typed into the wrong form.
        const dom = [
            { id: 'email', tag: 'input', role: 'textbox', inputType: 'email', autocomplete: 'email', ariaLabel: 'Email address', bbox: { x: 0, y: 100, width: 200, height: 40 }, visible: true, enabled: true },
            { id: 'password', tag: 'input', role: 'textbox', inputType: 'password', autocomplete: 'current-password', ariaLabel: 'Password', bbox: { x: 0, y: 160, width: 200, height: 40 }, visible: true, enabled: true },
            { id: 'submit-a', tag: 'button', role: 'button', text: 'Log in', bbox: { x: 0, y: 220, width: 90, height: 40 }, visible: true, enabled: true },
            { id: 'submit-b', tag: 'button', role: 'button', text: 'Log in', bbox: { x: 100, y: 220, width: 90, height: 40 }, visible: true, enabled: true }
        ];
        const result = new LocalAgent().analyze('login', dom, {});
        assert.strictEqual(result.decision, 'SERVER');
        assert.match(result.reason, /submit control is ambiguous/i);
    });

    test('prefers an unlabelled form submit over "Sign in with Apple"', () => {
        // Regression: on the real page the submit control is an unlabelled icon
        // button with an opaque id, so the only labelled candidates were the
        // social providers. "Sign in with Apple" sat nearest the fields and won,
        // so the agent tried to log in with Apple instead of with the email.
        const dom = [
            { id: 'sso-google', tag: 'button', role: 'button', ariaLabel: 'Continue with Google', text: 'Continue with Google', bbox: { x: 360, y: 200, width: 280, height: 44 }, visible: true, enabled: true },
            { id: 'sso-apple', tag: 'button', role: 'button', ariaLabel: 'Sign in with Apple', text: 'Sign in with Apple', bbox: { x: 360, y: 252, width: 280, height: 44 }, visible: true, enabled: true },
            { id: 'tab-email', tag: 'button', role: 'tab', text: 'Email', ariaSelected: 'true', bbox: { x: 360, y: 320, width: 140, height: 40 }, visible: true, enabled: true },
            { id: 'email', tag: 'input', role: 'textbox', inputType: 'email', name: 'email', autocomplete: 'email', placeholder: 'Enter your email...', bbox: { x: 360, y: 370, width: 280, height: 44 }, visible: true, enabled: true },
            { id: 'password', tag: 'input', role: 'textbox', inputType: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'Enter your password...', bbox: { x: 360, y: 430, width: 280, height: 44 }, visible: true, enabled: true },
            { id: 'forgot', tag: 'a', role: 'link', text: 'Forgot your password?', bbox: { x: 360, y: 486, width: 180, height: 20 }, visible: true, enabled: true },
            // Unlabelled icon button with an opaque id: the real submit.
            { id: 'e23', tag: 'button', role: 'button', bbox: { x: 660, y: 372, width: 44, height: 40 }, visible: true, enabled: true }
        ];
        const result = new LocalAgent().analyze('login', dom, {});
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions.map(a => `${a.type}->${a.target}`), [
            'type_local->email',
            'type_local->password',
            'click->e23',
            'done->'
        ]);
        // A social provider must never be the submit target for this form.
        assert.ok(!result.actions.some(a => a.target === 'sso-apple'));
        assert.ok(!result.actions.some(a => a.target === 'sso-google'));
    });

    test('a hidden field is not a second credential field', () => {
        // Forms routinely carry <input type="hidden" name="email"> alongside the
        // real field.  Counting every <input> as a text field found two identity
        // fields, so the login was reported ambiguous and the agent stalled on
        // the login page instead of filling it in.
        const dom = [
            { id: 'user', tag: 'input', role: 'textbox', inputType: 'email', name: 'email', ariaLabel: 'Email', bbox: { x: 360, y: 200, width: 280, height: 44 }, visible: true, enabled: true },
            { id: 'p1', tag: 'input', role: 'textbox', inputType: 'password', name: 'pass', ariaLabel: 'Password', bbox: { x: 360, y: 260, width: 280, hidden: true, visible: true, enabled: true } },
            { id: 'h1', tag: 'input', role: '', inputType: 'hidden', name: 'email', visible: true, enabled: true },
            { id: 'h2', tag: 'input', role: '', inputType: 'hidden', name: 'csrf', visible: true, enabled: true },
            { id: 'go', tag: 'button', role: 'button', text: 'Log in', ariaLabel: 'Log in', bbox: { x: 360, y: 320, width: 120, height: 40 }, visible: true, enabled: true }
        ];

        const result = new LocalAgent().analyze('login', dom, {});
        assert.strictEqual(result.decision, 'LOCAL', `login was not planned locally: ${result.reason}`);
        assert.deepStrictEqual(result.actions.map(a => `${a.type}->${a.target}`), [
            'type_local->user',
            'type_local->p1',
            'click->go',
            'done->'
        ], 'the visible fields are filled and the hidden ones are left alone');
    });

    test('does not mistake a link above the fields for a submit', () => {
        // The federated region is above the first credential field; a control
        // there is never this form's submit.
        const dom = [
            { id: 'sso-apple', tag: 'button', role: 'button', ariaLabel: 'Sign in with Apple', text: 'Sign in with Apple', bbox: { x: 360, y: 200, width: 280, height: 44 }, visible: true, enabled: true },
            { id: 'email', tag: 'input', role: 'textbox', inputType: 'email', autocomplete: 'email', ariaLabel: 'Email address', bbox: { x: 360, y: 370, width: 280, height: 44 }, visible: true, enabled: true },
            { id: 'password', tag: 'input', role: 'textbox', inputType: 'password', autocomplete: 'current-password', ariaLabel: 'Password', bbox: { x: 360, y: 430, width: 280, height: 44 }, visible: true, enabled: true },
            { id: 'e23', tag: 'button', role: 'button', bbox: { x: 360, y: 500, width: 280, height: 48 }, visible: true, enabled: true }
        ];
        const result = new LocalAgent().analyze('login', dom, {});
        assert.strictEqual(result.decision, 'LOCAL');
        assert.strictEqual(result.actions[2].target, 'e23');
    });

    test('local action broadcasts do not expose ordinary text', async () => {
        const result = await runLocalLoop('type "Run" into the task title');
        assert.strictEqual(result.backendCalls, 0);
        const update = result.updates.find(item => item.source === 'local');
        assert.ok(update);
        assert.equal(JSON.stringify(update).includes('Run'), false);
        assert.equal(update.actions[0].args.text, '[LOCAL_TEXT]');
    });

    test('local secret action stays local and carries no secret value', async () => {
        const result = await runLocalLoop('type my password into the password field');
        assert.strictEqual(result.backendCalls, 0);
        assert.strictEqual(result.privacyCalls, 0);
        assert.deepStrictEqual(result.executed[0], {
            type: 'type_local',
            target: 'password',
            args: { secret_ref: 'password' }
        });
        assert.equal(JSON.stringify(result.executed).includes('secret_value'), false);
    });

    test('server escalation still uses the existing gated backend path', async () => {
        const loop = new AgentLoop(9, 'find the cheapest flight');
        let backendCalls = 0;
        let privacyCalls = 0;
        const executed = [];
        loop.client.plan = async () => {
            backendCalls++;
            return {
                success: true,
                actions: [
                    { type: 'click', target: 'submit', args: {} },
                    { type: 'done', target: '', args: {} }
                ]
            };
        };
        loop._sendToContent = async (type, payload = {}) => {
            if (type === 'ANALYZE_DOM') return { elements: pageElements() };
            if (type === 'PRIVACY_PIPELINE') {
                privacyCalls++;
                return context(pageElements());
            }
            if (type === 'EXECUTE_VALIDATED_ACTION') {
                executed.push(payload.action);
                return { success: true };
            }
            return null;
        };
        loop._broadcast = () => {};
        loop._sleep = async () => {};
        loop.running = true;
        loop._generation = 0;

        await loop._cycle(0);

        assert.strictEqual(privacyCalls, 1);
        assert.strictEqual(backendCalls, 1);
        assert.deepStrictEqual(executed.map(action => action.type), ['click']);
        assert.strictEqual(loop.running, false);
    });

    test('server escalation is blocked when the existing privacy gate blocks', async () => {
        const loop = new AgentLoop(8, 'find the cheapest flight');
        let backendCalls = 0;
        let privacyCalls = 0;
        const updates = [];
        loop.client.plan = async () => {
            backendCalls++;
            return { success: true, actions: [] };
        };
        loop._sendToContent = async (type) => {
            if (type === 'ANALYZE_DOM') return { elements: pageElements() };
            if (type === 'PRIVACY_PIPELINE') {
                privacyCalls++;
                return { allowed: false, violations: ['test privacy gate'] };
            }
            return null;
        };
        loop._broadcast = update => updates.push(update);
        loop._sleep = async () => {};
        loop.running = true;
        loop._generation = 0;

        await loop._cycle(0);

        assert.strictEqual(privacyCalls, 1);
        assert.strictEqual(backendCalls, 0);
        assert.ok(updates.some(update => update.status === 'error'));
    });

    test('raw credential text is blocked instead of being escalated', () => {
        const result = new LocalAgent().analyze('type my password is hunter2 into the password field', pageElements());
        assert.strictEqual(result.decision, 'SERVER');
        assert.strictEqual(result.blockEscalation, true);
        assert.deepStrictEqual(result.actions, []);

        const pii = new LocalAgent().analyze('type alice@example.com into the task title', pageElements());
        assert.strictEqual(pii.decision, 'SERVER');
        assert.strictEqual(pii.blockEscalation, true);
    });

    test('local agent cannot produce arbitrary JavaScript actions', () => {
        const result = new LocalAgent().analyze('click javascript:alert(1)', pageElements());
        assert.strictEqual(result.decision, 'SERVER');
        const validation = validateActionPlan([{
            type: 'click',
            target: 'javascript:alert(1)',
            args: {}
        }]);
        assert.strictEqual(validation.ok, false);
    });

    test('local agent plans are terminal and do not loop', async () => {
        const result = await runLocalLoop('scroll down');
        assert.strictEqual(result.loop.cycleCount, 1);
        assert.strictEqual(result.loop.running, false);
        assert.strictEqual(result.backendCalls, 0);
    });

    test('exposes only the dynamic task-opening step before an editor exists', () => {
        const result = new LocalAgent().analyze('Add task named Study GOC', [
            node('add-task-trigger', 'button', { text: 'Add task' })
        ]);
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions.map(action => action.type), ['click']);
    });

    test('plans focus and typing when a task editor is visible', () => {
        const result = new LocalAgent().analyze('Add task named Study GOC', [
            node('task-editor', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                ariaLabel: 'Task title',
                text: ''
            }),
            node('add-task-submit', 'button', { text: 'Add task' })
        ]);
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions.map(action => action.type), ['focus', 'type_local']);
    });

    test('handles common Todoist task wording locally', () => {
        const result = new LocalAgent().analyze('Create a Todoist task called "Submit report"', [
            node('task-editor', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                ariaLabel: 'Task description',
                text: ''
            }),
            node('add-task-submit', 'button', { ariaLabel: 'Add task' })
        ]);
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions, [
            { type: 'focus', target: 'task-editor', args: {} },
            { type: 'type_local', target: 'task-editor', args: { text: 'Submit report' } }
        ]);
    });

    test('uses generic test-id metadata to ground a task composer', () => {
        const result = new LocalAgent().analyze('Add task named Study Cpp', [
            node('quick-add', 'button', { testId: 'add-task-button' }),
            node('quick-input', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                testId: 'add-task-input'
            })
        ]);
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions, [
            { type: 'focus', target: 'quick-input', args: {} },
            { type: 'type_local', target: 'quick-input', args: { text: 'Study Cpp' } }
        ]);
    });

    test('accepts the shorthand task title in a login sequence', () => {
        const result = new LocalAgent().analyze('Login and task "Study Cpp"', [
            node('task-editor', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                ariaLabel: 'Task title',
                text: ''
            })
        ]);
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions, [
            { type: 'focus', target: 'task-editor', args: {} },
            { type: 'type_local', target: 'task-editor', args: { text: 'Study Cpp' } }
        ]);
    });

    test('does not target a role-textbox email field when the task editor is absent', () => {
        const result = new LocalAgent().analyze('Login and add a task named "Study Cpp"', [
            node('email', 'input', { role: 'textbox', inputType: 'email', autocomplete: 'email', ariaLabel: 'Email' }),
            node('password', 'input', { role: 'textbox', inputType: 'password', autocomplete: 'current-password', ariaLabel: 'Password' })
        ]);
        assert.notStrictEqual(result.decision, 'LOCAL');
        assert.ok(!result.actions.some(action => action.target === 'email'));
    });

    test('does not use an email field as a task composer', () => {
        const result = new LocalAgent().analyze('add a task named "GOC"', [
            node('email', 'input', { inputType: 'email', autocomplete: 'email' }),
            node('password', 'input', { inputType: 'password', autocomplete: 'current-password' })
        ]);
        assert.notStrictEqual(result.decision, 'LOCAL');
        assert.ok(!result.actions.some(action => action.target === 'email'));
    });

    test('does not use a generically typed account field as a task composer', () => {
        const result = new LocalAgent().analyze('add a task named "GOC"', [
            node('account', 'input', {
                inputType: 'text',
                ariaLabel: 'Account email address',
                name: 'accountEmail'
            })
        ]);
        assert.notStrictEqual(result.decision, 'LOCAL');
        assert.ok(!result.actions.some(action => action.target === 'account'));
    });

    test('handles login then task across a missing task composer', () => {
        const loginResult = new LocalAgent().analyze('Login and add a task "GOC"', [
            node('email', 'input', { inputType: 'email', autocomplete: 'email', ariaLabel: 'Email' }),
            node('password', 'input', { inputType: 'password', autocomplete: 'current-password', ariaLabel: 'Password' }),
            node('login', 'button', { ariaLabel: 'Log in' })
        ]);
        assert.strictEqual(loginResult.decision, 'LOCAL');
        assert.ok(loginResult.actions.every(action => action.target !== 'email' || action.type === 'type_local'));

        const taskResult = new LocalAgent().analyze('Login and add a task "GOC"', [
            node('task-editor', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                ariaLabel: 'Task description',
                text: ''
            }),
            node('add-task', 'button', { ariaLabel: 'Add task' })
        ]);
        assert.strictEqual(taskResult.decision, 'LOCAL');
        assert.deepStrictEqual(taskResult.actions, [
            { type: 'focus', target: 'task-editor', args: {} },
            { type: 'type_local', target: 'task-editor', args: { text: 'GOC' } }
        ]);
    });

    test('clicks an already-filled login form without rewriting credentials', () => {
        const result = new LocalAgent().analyze('login', [
            node('email', 'input', { inputType: 'email', autocomplete: 'email', text: 'user@example.com' }),
            node('password', 'input', { inputType: 'password', autocomplete: 'current-password', text: 'browser-filled' }),
            node('login', 'button', { ariaLabel: 'Log in' })
        ]);
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions, [
            { type: 'click', target: 'login', args: {} },
            { type: 'done', target: '', args: {} }
        ]);
    });

    test('grounds a generic message editor and send control', () => {
        const result = new LocalAgent().analyze('send a message "hello"', [
            node('message-box', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                ariaLabel: 'Message'
            }),
            node('send-message', 'button', { ariaLabel: 'Send message' })
        ]);
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions.map(action => action.type), ['focus', 'type_local']);
    });

    test('parses a natural-language message destination without typing the instruction', () => {
        const result = new LocalAgent().analyze('Send the message "Its done bro" in texted box', [
            node('message-box', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                ariaLabel: 'Message'
            }),
            node('send-message', 'button', { ariaLabel: 'Send message' })
        ]);
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions, [
            { type: 'focus', target: 'message-box', args: {} },
            { type: 'type_local', target: 'message-box', args: { text: 'Its done bro' } }
        ]);
    });

    test('uses an allowlisted Enter action when no submit button is visible', () => {
        const result = new LocalAgent().analyze('press Enter to submit', [
            node('task-editor', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                ariaLabel: 'Task title'
            })
        ]);
        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions[0], {
            type: 'keypress',
            target: '',
            args: { key: 'Enter' }
        });
    });
});

describe('completion claims must survive verification', () => {
    const listPage = extra => [
        node('search', 'input', { role: 'searchbox', placeholder: 'Search' }),
        node('add', 'button', { ariaLabel: 'Add task' }),
        node('task-1', 'div', { text: 'Buy milk' }),
        ...extra
    ];

    test('a task id containing the text is not treated as an existing task', () => {
        // Regression: completion was claimed from any label carrying the text,
        // including an id or test id.  An id can contain the text while nothing
        // was ever created, so the run reported done and stopped.
        const result = new LocalAgent().analyze('Login and task "Study Cpp"', [
            ...listPage([{ ...node('task-study-cpp', 'div', {}), id: 'task-study-cpp', testId: 'row-Study-Cpp' }])
        ]);

        const isDoneOnly = (result.actions || []).every(action => action.type === 'done');
        assert.strictEqual(isDoneOnly, false,
            'an id or test id must never be evidence that the task exists');
    });

    test('a title attribute alone is not evidence either', () => {
        const result = new LocalAgent().analyze('add a task named "Study Cpp"', [
            ...listPage([{ ...node('row-9', 'div', { text: 'Untitled' }), title: 'Study Cpp' }])
        ]);

        const isDoneOnly = (result.actions || []).every(action => action.type === 'done');
        assert.strictEqual(isDoneOnly, false,
            'a tooltip is not evidence that the task exists');
    });

    test('a hidden node carrying the text is not evidence', () => {
        const result = new LocalAgent().analyze('add a task named "Study Cpp"', [
            ...listPage([{ ...node('ghost', 'div', { text: 'Study Cpp' }), visible: false }])
        ]);

        const isDoneOnly = (result.actions || []).every(action => action.type === 'done');
        assert.strictEqual(isDoneOnly, false,
            'an invisible node is not evidence that the task exists');
    });

    test('a genuinely visible task row still reports completion', () => {
        // The protection must survive: a real, visible row with the text is the
        // one case where claiming completion is correct.
        const result = new LocalAgent().analyze('add a task named "Study Cpp"', [
            ...listPage([node('task-new', 'div', { text: 'Study Cpp' })])
        ]);

        assert.deepStrictEqual(result.actions, [{ type: 'done', target: '', args: {} }]);
    });
});

describe('a search goal is the one case where a search field may be typed into', () => {
    const box = (x, y, width, height) => ({ x, y, width, height });
    const link = (id, text, y, x = 120) =>
        node(id, 'a', { role: 'link', text, bbox: box(x, y, 400, 20) });

    const searchBox = text => node('q', 'input', {
        role: 'searchbox',
        name: 'q',
        inputType: 'text',
        ariaLabel: 'Search Google',
        placeholder: 'Search Google or type a URL',
        bbox: box(120, 60, 600, 40),
        ...(text ? { text } : {})
    });

    // A horizontal run of short links.  A header row and a footer row both look
    // like this, and neither of them is a search result.
    const navRun = (prefix, y) => [
        link(`${prefix}1`, 'Images', y, 120),
        link(`${prefix}2`, 'Videos', y, 200),
        link(`${prefix}3`, 'News', y, 275),
        link(`${prefix}4`, 'Maps', y, 340)
    ];

    const HOME = () => [searchBox(''), ...navRun('h', 100), ...navRun('f', 900)];
    const TYPED = () => [searchBox('cpp tutorial'), ...navRun('h', 100), ...navRun('f', 900)];
    const RESULTS = () => [
        searchBox('cpp tutorial'),
        // Page furniture above the query box.  A header link can be as
        // descriptive as a result title, so only its position rules it out.
        link('brand', 'Acme Project Management Software', 20, 40),
        link('signin', 'Sign in', 20, 1000),
        ...navRun('h', 100),
        link('r1', 'The C++ programming language - cppreference', 180),
        link('r2', 'C++ Tutorial - W3Schools', 260),
        ...navRun('f', 900)
    ];
    // A footer rendered as a stacked link list rather than a row.  Each link
    // has its own baseline, so nothing about the layout gives them away except
    // how little text they carry.
    const STACKED_FOOTER = () => [
        searchBox(''),
        link('f1', 'Advertising', 900),
        link('f2', 'Business', 930),
        link('f3', 'Privacy', 960)
    ];
    const GOAL = 'search google for "cpp tutorial" and open the first result';

    test('the query is typed into the search field', () => {
        const result = new LocalAgent().analyze('search for "cpp tutorial"', HOME());

        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions.map(action => action.type), ['focus', 'type_local', 'done']);
        assert.strictEqual(result.actions[1].target, 'q');
        assert.strictEqual(result.actions[1].args.text, 'cpp tutorial');
    });

    test('a query already in the field is submitted, not retyped', () => {
        const result = new LocalAgent().analyze('search for "cpp tutorial"', TYPED());

        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions, [
            { type: 'keypress', target: '', args: { key: 'Enter' } },
            { type: 'done', target: '', args: {} }
        ], 'the plan must submit and then finish, so the run reaches a verified end');
    });

    test('the first result is opened and the page furniture is left alone', () => {
        const result = new LocalAgent().analyze('open the first result', RESULTS());

        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions, [
            { type: 'click', target: 'r1', args: {} },
            { type: 'done', target: '', args: {} }
        ]);
    });

    test('short page links are never mistaken for results', () => {
        // Regression risk: menus and footers sit below the query box too, so a
        // link read as "the first result" would send the agent to a site menu
        // instead of a search result.  A homepage has no results to open.
        const result = new LocalAgent().analyze('open the first result', HOME());

        assert.strictEqual(result.decision, 'SERVER');
        assert.deepStrictEqual(result.actions, []);
    });

    test('a stacked footer link list is never mistaken for results', () => {
        // Same risk with a different shape: footer links stacked instead of in a
        // row, so no two of them share a baseline to give them away.
        const result = new LocalAgent().analyze('open the first result', STACKED_FOOTER());

        assert.strictEqual(result.decision, 'SERVER');
        assert.deepStrictEqual(result.actions, []);
    });

    test('two results on one line are refused rather than guessed at', () => {
        const grid = [
            searchBox('cpp tutorial'),
            link('g1', 'First column result title', 200, 100),
            link('g2', 'Second column result title', 201, 500)
        ];
        const result = new LocalAgent().analyze('open the first result', grid);

        assert.strictEqual(result.decision, 'SERVER');
        assert.match(result.reason, /refusing to guess/i);
    });

    test('a page with links but no search control is not searched at all', () => {
        const result = new LocalAgent().analyze(GOAL, [link('x1', 'Some unrelated article', 200)]);

        assert.strictEqual(result.decision, 'SERVER');
        assert.deepStrictEqual(result.actions, []);
    });

    test('a results-only step with nothing to open does not submit the search', () => {
        // The second clause of the goal carries no query, so there is nothing to
        // type.  With no result to open either, the only action left would be
        // submitting whatever happens to be in the box, which was not asked for.
        const result = new LocalAgent().analyze('open the first result', TYPED());

        assert.strictEqual(result.decision, 'SERVER');
        assert.ok(!result.actions.some(action => action.type === 'type_local'),
            'no text may be typed for a step that only opens a result');
    });

    test('an already-submitted search is not submitted again', () => {
        // Once results are on the page the query step is finished; otherwise
        // every later cycle re-runs the same search.
        const result = new LocalAgent().analyze('search for "cpp tutorial"', RESULTS());

        assert.strictEqual(result.decision, 'LOCAL');
        assert.deepStrictEqual(result.actions, [{ type: 'done', target: '', args: {} }]);
    });

    test('the search field is not used as a shortcut for a task', () => {
        // The rule this feature relaxes: ordinary task text must never be typed
        // into a search box to dodge the task.  Only a search goal's own query
        // may go there, so every other text entry is still refused.
        const loop = new AgentLoop(3, 'add a task named "Study Cpp"');
        const dom = [searchBox('')];

        assert.strictEqual(loop._isUnsafeIdentityTextAction(
            { type: 'type_local', target: 'q', args: { text: 'Study Cpp' } }, dom), true,
            'task text must still be refused in a search field');
    });

    test('a search goal may type its own query into the search field', () => {
        const loop = new AgentLoop(3, GOAL);
        const dom = [searchBox('')];

        assert.strictEqual(loop._isUnsafeIdentityTextAction(
            { type: 'type_local', target: 'q', args: { text: 'cpp tutorial' } }, dom), false,
            'the query the goal asked for is allowed');
    });

    test('a search goal may not type some other text into the search field', () => {
        // Allowing the query must not become allowing anything at all.
        const loop = new AgentLoop(3, GOAL);
        const dom = [searchBox('')];

        assert.strictEqual(loop._isUnsafeIdentityTextAction(
            { type: 'type_local', target: 'q', args: { text: 'my email is a@b.com' } }, dom), true,
            'text that is not the query is still refused');
    });

    test('typing no text at all is still not a permitted search', () => {
        // An empty text equals an empty query, so the match succeeds on its own
        // for a goal that names no query.  Nothing to type is not the same as
        // typing the goal's query, and an empty entry is what would silently
        // clear a search the user already ran.
        const loop = new AgentLoop(3, 'add a task named "Study Cpp"');
        const dom = [searchBox('')];

        assert.strictEqual(loop._isUnsafeIdentityTextAction(
            { type: 'type_local', target: 'q', args: { text: '' } }, dom), true,
            'an empty string is never a query the goal asked for');
    });

    test('a search query is never typed into a credential field', () => {
        const loop = new AgentLoop(3, GOAL);
        const dom = [
            node('email', 'input', { role: 'textbox', inputType: 'email', name: 'email', ariaLabel: 'Email' }),
            searchBox('')
        ];

        assert.strictEqual(loop._isUnsafeIdentityTextAction(
            { type: 'type_local', target: 'email', args: { text: 'cpp tutorial' } }, dom), true,
            'a search control on the page does not license the email field');
    });
});

/**
 * The search controls of the real google.com homepage.
 *
 * The idealized fixtures above give the search box role="searchbox" and a
 * descriptive placeholder.  The shipped page does neither: it is a bare
 * <textarea name="q" role="combobox" aria-label="Search">, flanked by
 * <input type="submit"> buttons whose labels contain the word "search", plus a
 * file picker, hidden fields and a second textarea.  These nodes are what
 * dom_analyzer emits for that markup.
 *
 * Of those only two carry an id, so _usableNodes keeps the query box and
 * discards the buttons: on the live page the submit buttons never competed for
 * the field.  What did break the live page was the query text, which is what
 * the engine-name cases below pin down.  The button cases are kept as unit
 * rules about _findSearchField, which is reachable directly.
 */
describe('the real google.com homepage is searched through its textarea', () => {
    const box = (x, y, width, height) => ({ x, y, width, height });

    const QUERY_BOX = node('ti6dpd', 'textarea', {
        role: 'combobox',
        inputType: 'textarea',
        name: 'q',
        ariaLabel: 'Search',
        placeholder: '',
        autocomplete: 'off',
        bbox: box(120, 100, 600, 44),
        text: ''
    });
    const submit = (name, ariaLabel) => node('', 'input', {
        role: 'button',
        inputType: 'submit',
        name,
        ariaLabel,
        bbox: box(600, 100, 40, 40)
    });
    const PAGE = () => [
        node('', 'input', { role: '', inputType: 'file', bbox: box(10, 10, 20, 20) }),
        QUERY_BOX,
        // Google ships its desktop and mobile markup together, so each button
        // appears twice.
        submit('btnK', 'Google Search'),
        submit('btnI', "I'm Feeling Lucky"),
        submit('btnK', 'Google Search'),
        submit('btnI', "I'm Feeling Lucky"),
        node('', 'input', { role: '', inputType: 'hidden', name: 'sca_esv', bbox: box(0, 0, 0, 0) }),
        node('', 'input', { role: '', inputType: 'hidden', name: 'sxsrf', bbox: box(0, 0, 0, 0) }),
        // The cookie-consent textarea is a real text box, which is exactly why
        // the field has to be chosen by score rather than by being the only one.
        node('', 'textarea', { role: 'textbox', inputType: 'textarea', name: 'csi', bbox: box(0, 0, 0, 0) })
    ];

    test('a submit button labelled "Google Search" is not the search box', () => {
        const agent = new LocalAgent();

        assert.strictEqual(agent._findSearchField(PAGE())?.id, 'ti6dpd',
            'the query goes into the textarea, not the button that submits it');
    });

    test('the real query box is recognised as an ordinary editable field', () => {
        const agent = new LocalAgent();

        assert.strictEqual(agent._isEditable(QUERY_BOX), true,
            'a combobox textarea is a text target');
    });

    test('controls that cannot hold text are not editable targets', () => {
        const agent = new LocalAgent();
        const notEditable = [
            submit('btnK', 'Google Search'),
            node('', 'input', { role: '', inputType: 'hidden', name: 'sca_esv' }),
            node('', 'input', { role: '', inputType: 'file' }),
            node('', 'input', { role: 'checkbox', inputType: 'checkbox' }),
            node('', 'input', { role: 'button', inputType: 'button' })
        ];

        for (const candidate of notEditable) {
            assert.strictEqual(agent._isEditable(candidate), false,
                `an input[type=${candidate.inputType}] cannot receive a query`);
        }
    });

    test('the engine name is part of the phrasing, not the query', () => {
        const agent = new LocalAgent();
        // "search google for cpp tutorial" matched on "search", could not then
        // match "for" because "google" was in the way, and captured the whole
        // remainder as the query.
        const cases = [
            ['search google for cpp tutorial and open the first result', 'cpp tutorial'],
            ['search on google for cpp tutorial', 'cpp tutorial'],
            ['google for cpp tutorial', 'cpp tutorial'],
            ['search for cpp tutorial', 'cpp tutorial'],
            ['search cpp tutorial', 'cpp tutorial'],
            ['search bing for c++ vectors', 'c++ vectors']
        ];

        for (const [goal, expected] of cases) {
            assert.strictEqual(agent._searchIntent(goal)?.query, expected,
                `query for ${JSON.stringify(goal)}`);
        }
    });

    test('the whole query is typed into the real query box', () => {
        const plan = new LocalAgent()._planSearch(
            'search google for cpp tutorial and open the first result', PAGE());

        assert.deepStrictEqual(plan?.actions?.map(action => [action.type, action.target]), [
            ['focus', 'ti6dpd'],
            ['type_local', 'ti6dpd'],
            ['done', '']
        ], 'focus, type, done against the real query box');
        assert.strictEqual(plan.actions[1].args.text, 'cpp tutorial',
            'only the query is typed, without the engine name');
    });

    test('the loop accepts the query the planner typed and refuses a button', () => {
        const loop = new AgentLoop(3, 'search google for cpp tutorial and open the first result');
        const dom = PAGE();

        assert.strictEqual(loop._isUnsafeIdentityTextAction(
            { type: 'type_local', target: 'ti6dpd', args: { text: 'cpp tutorial' } }, dom), false,
            'the planner\'s own query is allowed into the search box');
        // The planner and the gate used to parse the goal with two different
        // regexes.  When they disagreed the gate blocked the correct query and
        // the search simply never happened.
        assert.strictEqual(loop._searchQuery(loop.goal), 'cpp tutorial',
            'the loop and the planner read the same query out of the goal');
        assert.strictEqual(loop._isUnsafeIdentityTextAction(
            { type: 'type_local', target: 'ti6dpd', args: { text: 'buy now cheap' } }, dom), true,
            'text that is not the goal\'s query is still refused');
    });
});

