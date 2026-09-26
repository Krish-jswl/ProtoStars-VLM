import { test, describe } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import {
    resolveTarget,
    resolveActionTarget,
    descriptorForNode
} from '../extension/background/action_grounding.js';
import { validateActionPlan } from '../extension/background/api_client.js';
import { ActionExecutor } from '../extension/content/action_executor.js';
import { parseLocalVisionOutput } from '../extension/local_agent/local_vision_protocol.js';

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
        bbox: { x: 0, y: 0, width: 120, height: 32 },
        visible: true,
        enabled: true,
        ...values
    };
}

describe('Action grounding and safe action contract', () => {
    test('resolves stable IDs before semantic labels', () => {
        const nodes = [node('add-task', 'button', { text: 'Add task' })];
        const result = resolveTarget('add-task', nodes, null, { actionType: 'click' });
        assert.strictEqual(result.status, 'resolved');
        assert.strictEqual(result.target, 'add-task');
        assert.strictEqual(result.grounding, 'stable-id');
    });

    test('matches normalized UI variants without relying on exact punctuation', () => {
        const nodes = [node('create-task', 'button', { text: 'Add task' })];
        for (const phrase of ['Create task', 'create a task', '  ADD   TASK  ']) {
            const result = resolveTarget(phrase, nodes, null, { actionType: 'click' });
            assert.strictEqual(result.status, 'resolved', phrase);
            assert.strictEqual(result.target, 'create-task');
        }
    });

    test('rejects ambiguous semantic targets', () => {
        const nodes = [
            node('first-add', 'button', { text: 'Add task' }),
            node('second-add', 'button', { text: 'Add task' })
        ];
        const result = resolveTarget('Add task', nodes, null, { actionType: 'click' });
        assert.strictEqual(result.status, 'ambiguous');
    });

    test('re-grounds a stale ID from semantic metadata', () => {
        const original = node('old-submit', 'button', {
            text: 'Save changes',
            role: 'button',
            bbox: { x: 200, y: 100, width: 100, height: 32 }
        });
        const replacement = node('new-submit', 'button', {
            text: 'Save changes',
            role: 'button',
            bbox: { x: 200, y: 100, width: 100, height: 32 }
        });
        const result = resolveTarget('old-submit', [replacement], descriptorForNode(original), {
            actionType: 'click'
        });
        assert.strictEqual(result.status, 'resolved');
        assert.strictEqual(result.target, 'new-submit');
        assert.strictEqual(result.grounding, 'descriptor');
    });

    test('uses bounding-box proximity only to disambiguate equal labels', () => {
        const descriptor = descriptorForNode(node('old', 'button', {
            text: 'Add task',
            bbox: { x: 10, y: 10, width: 80, height: 30 }
        }));
        const nodes = [
            node('far', 'button', { text: 'Add task', bbox: { x: 500, y: 400, width: 80, height: 30 } }),
            node('near', 'button', { text: 'Add task', bbox: { x: 12, y: 12, width: 80, height: 30 } })
        ];
        const result = resolveTarget('old', nodes, descriptor, { actionType: 'click' });
        assert.strictEqual(result.status, 'resolved');
        assert.strictEqual(result.target, 'near');
    });

    test('allows only allowlisted keypress actions and active-element targets', () => {
        assert.strictEqual(validateActionPlan([
            { type: 'keypress', target: '', args: { key: 'Enter' } },
            { type: 'done', target: '', args: {} }
        ]).ok, true);
        assert.strictEqual(validateActionPlan([
            { type: 'keypress', target: '', args: { key: 'Shift' } }
        ]).ok, false);
        assert.strictEqual(validateActionPlan([
            { type: 'keypress', target: '', args: { key: 'Enter', code: 'process' } }
        ]).ok, false);
        assert.strictEqual(validateActionPlan([
            { type: 'wait', target: '', args: { ms: 999999 } },
            { type: 'done', target: '', args: {} }
        ]).actions[0].args.ms, 5000);
        assert.strictEqual(resolveActionTarget(
            { type: 'keypress', target: '', args: { key: 'Enter' } },
            []
        ).grounding, 'active-element');
    });

    test('rejects duplicate type actions in one bounded plan', () => {
        const duplicate = validateActionPlan([
            { type: 'type_local', target: 'message', args: { text: 'Its done bro' } },
            { type: 'type_local', target: 'message', args: { text: 'Its done bro' } }
        ]);
        assert.strictEqual(duplicate.ok, false);
        assert.strictEqual(validateActionPlan([
            { type: 'type_local', target: 'message', args: { text: 'Its done bro' } },
            { type: 'type_local', target: 'search', args: { text: 'Its done bro' } }
        ]).ok, true);
    });

    test('resolves role=textbox for type_local even without contenteditable attribute', () => {
        // SPA editors (Notion, Slack, etc.) use div[role="textbox"] where the
        // contenteditable attribute may not be present or reflected as inputType.
        // role="textbox" by ARIA spec means the element IS an editable text control.
        const result = resolveActionTarget(
            { type: 'type_local', target: 'fake-editor', args: { text: 'GOC' } },
            [node('fake-editor', 'div', { role: 'textbox', ariaLabel: 'Task' })]
        );
        assert.strictEqual(result.status, 'resolved');
    });

    test('grounds common custom ARIA controls as click targets', () => {
        const nodes = [
            node('check', 'div', { role: 'checkbox', ariaLabel: 'Mark important' }),
            node('option', 'div', { role: 'option', text: 'Study' })
        ];
        assert.strictEqual(resolveTarget('Mark important', nodes, null, { actionType: 'click' }).target, 'check');
        assert.strictEqual(resolveTarget('Study', nodes, null, { actionType: 'click' }).target, 'option');
    });

    test('uses OCR geometry only to disambiguate a visual label', () => {
        const nodes = [
            node('far-add', 'button', { text: 'Add task', bbox: { x: 500, y: 400, width: 100, height: 30 } }),
            node('near-add', 'button', { text: 'Add task', bbox: { x: 20, y: 20, width: 100, height: 30 } })
        ];
        const parsed = parseLocalVisionOutput('Add task', 'click Add task', nodes, [{
            text: 'Add task',
            bbox: { x: 22, y: 22, width: 90, height: 25 }
        }]);
        assert.strictEqual(parsed.ok, true);
        assert.strictEqual(parsed.actions[0].target, 'near-add');
    });

    test('does not accept arbitrary selectors as action targets', () => {
        const plan = validateActionPlan([{ type: 'click', target: 'button.primary', args: {} }]);
        assert.strictEqual(plan.ok, false);
        assert.strictEqual(validateActionPlan([{ type: 'click', target: 'body', args: {} }]).ok, false);
        assert.strictEqual(ActionExecutor.selectorForTarget('button.primary'), null);
        assert.strictEqual(ActionExecutor.selectorForTarget('[data-x="y"]'), null);
    });

    test('dispatches Enter to the active form exactly once', async () => {
        const dom = new JSDOM('<form><input id="title" /></form>');
        global.window = dom.window;
        global.document = dom.window.document;
        const input = document.getElementById('title');
        input.getBoundingClientRect = () => ({ x: 0, y: 0, width:200, height: 30 });
        input.focus();
        let keyEvents = 0;
        let submits = 0;
        input.addEventListener('keydown', () => { keyEvents++; });
        dom.window.HTMLFormElement.prototype.requestSubmit = function () { submits++; };
        const executor = new ActionExecutor({
            actionValidation: {
                requireVisible: true,
                allowedActions: ['keypress']
            }
        });
        const result = await executor.execute('keypress', '', { key: 'Enter' });
        assert.deepStrictEqual(result, { success: true });
        assert.strictEqual(keyEvents, 1);
        assert.strictEqual(submits, 1);
    });
});
