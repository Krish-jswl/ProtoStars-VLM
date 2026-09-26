import { test, describe } from 'node:test';
import assert from 'node:assert';
import { AgentLoop } from '../extension/background/agent_loop.js';

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
        bbox: { x: 0, y: 0, width: 160, height: 32 },
        visible: true,
        enabled: true,
        ...values
    };
}

function pageContext(elements, goal = 'bounded task') {
    return {
        allowed: true,
        sanitizedContext: {
            goal,
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

async function runCycles(loop, limit = 20) {
    const scheduled = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback) => {
        scheduled.push(callback);
        return scheduled.length;
    };
    try {
        await loop._cycle(loop._generation);
        let count = 0;
        while (loop.running && scheduled.length && count++ < limit) {
            const callback = scheduled.shift();
            await callback();
        }
        return count;
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }
}

describe('SPA action execution lifecycle', () => {
    test('executes a local task flow one action at a time and verifies completion', async () => {
        const state = { opened: false, title: '', tasks: [], active: null };
        const elements = () => {
            const result = [node('add-trigger', 'button', { text: 'Add task' })];
            if (state.opened) {
                result.push(node('editor-live', 'div', {
                    role: 'textbox',
                    inputType: 'contenteditable',
                    ariaLabel: 'Task title',
                    text: state.title
                }));
                result.push(node('submit-live', 'button', { text: 'Add task' }));
            }
            for (const task of state.tasks) result.push(node(`task-${task}`, 'li', { text: task }));
            return result;
        };

        const loop = new AgentLoop(1, 'Add task named Study GOC', {
            localVisionAgent: { shouldAttempt: () => false }
        });
        const executed = [];
        let privacyCalls = 0;
        loop._sendToContent = async (type, payload = {}) => {
            if (type === 'ANALYZE_DOM') return { elements: elements() };
            if (type === 'PRIVACY_PIPELINE') {
                privacyCalls++;
                return pageContext(elements());
            }
            if (type === 'EXECUTE_VALIDATED_ACTION') {
                const action = payload.action;
                executed.push(action);
                if (action.type === 'click' && action.target === 'add-trigger') {
                    state.opened = true;
                } else if (action.type === 'focus') {
                    state.active = action.target;
                } else if (action.type === 'type_local') {
                    state.title = action.args.text;
                } else if (action.type === 'keypress') {
                    if (state.title) state.tasks.push(state.title);
                } else if (action.type === 'click' && action.target === 'submit-live' && state.title) {
                    state.tasks.push(state.title);
                    state.title = '';
                }
                return action.type === 'type_local'
                    ? { success: true, verified: true }
                    : { success: true };
            }
            return null;
        };
        loop.client.plan = async () => ({ success: true, actions: [] });
        loop._broadcast = () => {};
        loop._sleep = async () => {};
        loop.running = true;
        loop._generation = 0;

        const cycles = await runCycles(loop);
        assert.ok(cycles >= 4);
        assert.deepStrictEqual(executed.map(action => action.type), ['click', 'focus', 'type_local', 'click']);
        assert.deepStrictEqual(state.tasks, ['Study GOC']);
        assert.strictEqual(privacyCalls, 0);
        assert.strictEqual(loop.running, false);
    });

    test('re-resolves a stale target after a rerender before executing it', async () => {
        let replaced = false;
        const initial = [
            node('old-trigger', 'button', { text: 'Open editor' }),
            node('old-submit', 'button', {
                text: 'Save task',
                role: 'button',
                bbox: { x: 220, y: 100, width: 120, height: 32 }
            })
        ];
        const current = () => replaced
            ? [
                node('new-trigger', 'button', { text: 'Open editor' }),
                node('new-submit', 'button', {
                    text: 'Save task',
                    role: 'button',
                    bbox: { x: 220, y: 100, width: 120, height: 32 }
                })
            ]
            : initial;
        const loop = new AgentLoop(2, 'compare the available controls', {
            localVisionAgent: { shouldAttempt: () => false }
        });
        const executed = [];
        loop._sendToContent = async (type, payload = {}) => {
            if (type === 'ANALYZE_DOM') return { elements: current() };
            if (type === 'PRIVACY_PIPELINE') return pageContext(current());
            if (type === 'EXECUTE_VALIDATED_ACTION') {
                executed.push(payload.action);
                if (payload.action.target === 'old-trigger') replaced = true;
                return { success: true };
            }
            return null;
        };
        loop.client.plan = async () => ({
            success: true,
            actions: [
                { type: 'click', target: 'old-trigger', args: {} },
                { type: 'click', target: 'old-submit', args: {} },
                { type: 'done', target: '', args: {} }
            ]
        });
        loop._broadcast = () => {};
        loop._sleep = async () => {};
        loop.running = true;
        loop._generation = 0;

        await runCycles(loop);
        assert.deepStrictEqual(executed.map(action => action.target), ['old-trigger', 'new-submit']);
        assert.strictEqual(loop.running, false);
    });

    test('sends a grounded message locally and verifies the conversation result', async () => {
        const state = { draft: '', messages: [] };
        const elements = () => [
            node('message-editor', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                ariaLabel: 'Message',
                text: state.draft
            }),
            node('send-message', 'button', { ariaLabel: 'Send message' }),
            ...state.messages.map((text, index) => node(`message-${index}`, 'div', { text }))
        ];
        const messageEvents = [];
        const loop = new AgentLoop(4, 'Send the message "hello" in texted box', {
            localVisionAgent: { shouldAttempt: () => false },
            onMessageSubmitted: (event) => messageEvents.push(['submitted', event.text]),
            onMessageConfirmed: (event) => messageEvents.push(['confirmed', event.text])
        });
        const executed = [];
        loop._sendToContent = async (type, payload = {}) => {
            if (type === 'ANALYZE_DOM') return { elements: elements() };
            if (type === 'PRIVACY_PIPELINE') return pageContext(elements(), 'Send the message "hello" in texted box');
            if (type === 'EXECUTE_VALIDATED_ACTION') {
                const action = payload.action;
                executed.push(action);
                if (action.type === 'type_local') state.draft = action.args.text;
                if (action.type === 'click' && action.target === 'send-message') {
                    state.messages.push(state.draft);
                    state.draft = '';
                }
                return action.type === 'type_local'
                    ? { success: true, verified: true }
                    : { success: true };
            }
            return null;
        };
        loop.client.plan = async () => ({ success: true, actions: [] });
        loop._broadcast = () => {};
        loop._sleep = async () => {};
        loop.running = true;
        loop._generation = 0;

        await runCycles(loop);
        assert.deepStrictEqual(executed.map(action => action.type), ['focus', 'type_local', 'click']);
        assert.deepStrictEqual(state.messages, ['hello']);
        assert.deepStrictEqual(messageEvents, [
            ['submitted', 'hello'],
            ['confirmed', 'hello']
        ]);
        assert.strictEqual(loop.running, false);
    });

    test('runs login then task without targeting the email field for task text', async () => {
        const state = { loggedIn: false, draft: '', taskAdded: false };
        const elements = () => state.loggedIn
            ? [
                node('task-editor', 'div', {
                    role: 'textbox',
                    inputType: 'contenteditable',
                    ariaLabel: 'Task description',
                    text: state.draft
                }),
                node('add-task', 'button', { ariaLabel: 'Add task' })
            ]
            : [
                node('email', 'input', { inputType: 'email', autocomplete: 'email', ariaLabel: 'Email' }),
                node('password', 'input', { inputType: 'password', autocomplete: 'current-password', ariaLabel: 'Password' }),
                node('login', 'button', { ariaLabel: 'Log in' })
            ];
        const loop = new AgentLoop(4, 'Login and add a task "GOC"', {
            localVisionAgent: { shouldAttempt: () => false }
        });
        const executed = [];
        loop._sendToContent = async (type, payload = {}) => {
            if (type === 'ANALYZE_DOM') return { elements: elements() };
            if (type === 'PRIVACY_PIPELINE') return pageContext(elements(), 'Login and add a task "GOC"');
            if (type === 'EXECUTE_VALIDATED_ACTION') {
                const action = payload.action;
                executed.push(action);
                if (action.type === 'click' && action.target === 'login') state.loggedIn = true;
                if (action.type === 'type_local' && action.target === 'task-editor') state.draft = action.args.text;
                if (action.type === 'click' && action.target === 'add-task' && state.draft) {
                    state.taskAdded = true;
                    state.draft = '';
                }
                return { success: true, verified: true };
            }
            return null;
        };
        loop.client.plan = async () => ({ success: true, actions: [] });
        loop._broadcast = () => {};
        loop._sleep = async () => {};
        loop.running = true;
        loop._generation = 0;

        await runCycles(loop, 20);
        assert.deepStrictEqual(executed.map(action => `${action.type}:${action.target}`), [
            'type_local:email',
            'type_local:password',
            'click:login',
            'focus:task-editor',
            'type_local:task-editor',
            'click:add-task'
        ]);
        assert.strictEqual(state.taskAdded, true);
    });

    test('does not replay a message when the sent bubble is not immediately observed', async () => {
        const state = { draft: '', sendClicks: 0 };
        const elements = () => [
            node('message-editor', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                ariaLabel: 'Message',
                text: state.draft
            }),
            node('send-message', 'button', { ariaLabel: 'Send message' })
        ];
        const loop = new AgentLoop(4, 'Send the message "hello" in texted box', {
            localVisionAgent: { shouldAttempt: () => false }
        });
        const executed = [];
        loop._sendToContent = async (type, payload = {}) => {
            if (type === 'ANALYZE_DOM') return { elements: elements() };
            if (type === 'PRIVACY_PIPELINE') return pageContext(elements(), 'Send the message "hello" in texted box');
            if (type === 'EXECUTE_VALIDATED_ACTION') {
                const action = payload.action;
                executed.push(action);
                if (action.type === 'type_local') state.draft = action.args.text;
                if (action.type === 'click' && action.target === 'send-message') {
                    state.sendClicks += 1;
                    state.draft = '';
                    // Simulate a UI that accepted the click but has not exposed
                    // the outgoing bubble in the next observation.
                }
                return action.type === 'type_local'
                    ? { success: true, verified: true }
                    : { success: true };
            }
            return null;
        };
        loop.client.plan = async () => ({ success: true, actions: [] });
        loop._broadcast = () => {};
        loop._sleep = async () => {};
        loop.running = true;
        loop._generation = 0;

        await runCycles(loop, 20);
        assert.deepStrictEqual(executed.map(action => action.type), ['focus', 'type_local', 'click']);
        assert.strictEqual(state.sendClicks, 1);
        assert.strictEqual(loop.running, false);
    });

    test('uses a verified draft with Enter instead of typing it again when no send label exists', async () => {
        const state = { draft: '', enterCount: 0, messages: [] };
        const elements = () => [
            node('message-editor', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                ariaLabel: 'Message',
                // Simulate an editor that clears its DOM text before the next
                // observation even though the draft was inserted successfully.
                text: ''
            })
        ];
        const loop = new AgentLoop(4, 'send a message "hello"', {
            localVisionAgent: { shouldAttempt: () => false }
        });
        const executed = [];
        loop._sendToContent = async (type, payload = {}) => {
            if (type === 'ANALYZE_DOM') return { elements: elements() };
            if (type === 'PRIVACY_PIPELINE') return pageContext(elements(), 'send a message "hello"');
            if (type === 'EXECUTE_VALIDATED_ACTION') {
                const action = payload.action;
                executed.push(action);
                if (action.type === 'type_local') state.draft = action.args.text;
                if (action.type === 'keypress') {
                    state.enterCount += 1;
                    if (state.draft) state.messages.push(state.draft);
                    state.draft = '';
                }
                return action.type === 'type_local'
                    ? { success: true, verified: true }
                    : { success: true };
            }
            return null;
        };
        loop.client.plan = async () => ({ success: true, actions: [] });
        loop._broadcast = () => {};
        loop._sleep = async () => {};
        loop.running = true;
        loop._generation = 0;

        await runCycles(loop, 20);
        assert.deepStrictEqual(executed.map(action => action.type), ['focus', 'type_local', 'keypress']);
        assert.strictEqual(state.enterCount, 1);
        assert.deepStrictEqual(state.messages, ['hello']);
    });

    test('does not mark a task done when the postcondition is absent', async () => {
        const elements = [
            node('task-editor', 'div', {
                role: 'textbox',
                inputType: 'contenteditable',
                text: 'Study GOC'
            }),
            node('task-submit', 'button', { text: 'Add task' })
        ];
        const loop = new AgentLoop(3, 'Add task named Study GOC', {
            localVisionAgent: { shouldAttempt: () => false }
        });
        let executed = 0;
        loop._sendToContent = async (type, payload = {}) => {
            if (type === 'ANALYZE_DOM') return { elements };
            if (type === 'PRIVACY_PIPELINE') return pageContext(elements);
            if (type === 'EXECUTE_VALIDATED_ACTION') {
                executed++;
                return { success: true };
            }
            return null;
        };
        loop.client.plan = async () => ({
            success: true,
            actions: [
                { type: 'click', target: 'task-submit', args: {} },
                { type: 'done', target: '', args: {} }
            ]
        });
        loop._broadcast = () => {};
        loop._sleep = async () => {};
        loop.running = true;
        loop._generation = 0;

        await loop._cycle(0);
        assert.strictEqual(executed, 1);
        assert.strictEqual(loop.running, true, 'a missing task result must trigger re-observation');
    });
});
