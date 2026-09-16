
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { ActionExecutor } from '../extension/content/action_executor.js';

const config = {
    actionValidation: {
        requireVisible: true,
        allowedActions: ['click', 'scroll', 'focus']
    }
};

describe('Action Executor Tests', () => {
    beforeEach(() => {
        const dom = new JSDOM(`
            <!DOCTYPE html>
            <button id="visible-btn">Click me</button>
            <button id="hidden-btn" style="display: none;">Hidden</button>
            <button id="disabled-btn" disabled>Disabled</button>
        `);
        
        global.document = dom.window.document;
        global.window = dom.window;
        
        dom.window.HTMLElement.prototype.getBoundingClientRect = function() {
            if (this.id === 'visible-btn') return {x: 10, y: 10, width: 100, height: 40};
            if (this.id === 'disabled-btn') return {x: 10, y: 60, width: 100, height: 40};
            return {x: 0, y: 0, width: 0, height: 0};
        };
    });

    test('Executes click on valid target', () => {
        const executor = new ActionExecutor(config);
        
        let clicked = false;
        document.getElementById('visible-btn').addEventListener('click', () => {
            clicked = true;
        });

        const result = executor.execute('click', '#visible-btn');
        assert.strictEqual(result.success, true);
        assert.strictEqual(clicked, true);
    });

    test('Validates target visibility', () => {
        const executor = new ActionExecutor(config);
        const result = executor.execute('click', '#hidden-btn');
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'Element not visible (zero size)');
    });

    test('Validates element disabled state', () => {
        const executor = new ActionExecutor(config);
        const result = executor.execute('click', '#disabled-btn');
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'Element disabled');
    });

    test('Rejects unallowed actions', () => {
        const executor = new ActionExecutor(config);
        const result = executor.execute('type', '#visible-btn');
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'Action type not allowed');
    });
});
