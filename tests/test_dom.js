
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { DOMAnalyzer } from '../extension/content/dom_analyzer.js';

describe('DOM Analyzer Tests', () => {
    test('captures empty contenteditable title elements', () => {
        const dom = new JSDOM('<div id="title" contenteditable role="textbox"></div>');
        global.document = dom.window.document;
        global.window = dom.window;
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
            x: 0, y: 0, width: 300, height: 30
        });

        const result = new DOMAnalyzer().analyzeDOM();
        const title = result.find(node => node.id === 'title');

        assert.ok(title);
        assert.strictEqual(title.inputType, 'contenteditable');
        assert.strictEqual(title.role, 'textbox');
    });

    test('Extracts metadata correctly', () => {
        const dom = new JSDOM(`
            <!DOCTYPE html>
            <button id="btn1" role="button" class="btn">Test Button</button>
            <input type="password" id="pass" />
        `);
        
        global.document = dom.window.document;
        global.window = dom.window;

        // Mock bounding boxes
        dom.window.HTMLElement.prototype.getBoundingClientRect = function() {
            if (this.id === 'btn1') return {x: 10, y: 10, width: 100, height: 40};
            if (this.id === 'pass') return {x: 10, y: 60, width: 200, height: 30};
            return {x:0, y:0, width:0, height:0};
        };

        const analyzer = new DOMAnalyzer();
        const results = analyzer.analyzeDOM();
        
        assert.strictEqual(results.length, 2);
        
        const btn = results[0];
        assert.strictEqual(btn.id, 'btn1');
        assert.strictEqual(btn.role, 'button');
        assert.strictEqual(btn.tag, 'button');
        assert.strictEqual(btn.text, 'Test Button');
        assert.strictEqual(btn.bbox.width, 100);
        
        const input = results[1];
        assert.strictEqual(input.id, 'pass');
        assert.strictEqual(input.inputType, 'password');
        assert.strictEqual(input.tag, 'input');
    });

    test('captures nested button text and stable aliases for unsafe IDs', () => {
        const dom = new JSDOM(`
            <button id="unsafe.id"><span>Add task</span></button>
            <button id="labelled" aria-labelledby="label-id"></button><span id="label-id">Task title</span>
        `);
        global.document = dom.window.document;
        global.window = dom.window;
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
            x: 0, y: 0, width: 160, height: 32
        });
        const results = new DOMAnalyzer().analyzeDOM();
        const button = results.find(node => node.text === 'Add task');
        assert.ok(button);
        assert.match(button.id, /^pva-[a-z0-9-]+$/);
        const labelled = results.find(node => node.id === 'labelled');
        assert.ok(labelled?.label.includes('Task title'));
    });

    test('observes common custom ARIA controls for generic actions', () => {
        const dom = new JSDOM(`
            <div id="custom-check" role="checkbox" aria-label="Mark important" tabindex="0"></div>
            <div id="custom-option" role="option" aria-label="Study">Study</div>
        `);
        global.document = dom.window.document;
        global.window = dom.window;
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 120, height: 30 });
        const result = new DOMAnalyzer().analyzeDOM();
        assert.ok(result.some(node => node.id === 'custom-check' && node.role === 'checkbox'));
        assert.ok(result.some(node => node.id === 'custom-option' && node.role === 'option'));
    });

    test('captures generic title and test-id semantics', () => {
        const dom = new JSDOM('<div id="task-editor" contenteditable data-testid="add-task-input" title="Task title"></div>');
        global.document = dom.window.document;
        global.window = dom.window;
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
            x: 0, y: 0, width: 300, height: 30
        });
        const node = new DOMAnalyzer().analyzeDOM().find(item => item.id === 'task-editor');
        assert.strictEqual(node.testId, 'add-task-input');
        assert.strictEqual(node.title, 'Task title');
    });

    test('retains read-only and aria-disabled state for action validation', () => {
        const dom = new JSDOM('<input id="title" readonly aria-disabled="true">');
        global.document = dom.window.document;
        global.window = dom.window;
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 30 });
        const result = new DOMAnalyzer().analyzeDOM().find(node => node.id === 'title');
        assert.strictEqual(result.readOnly, true);
        assert.strictEqual(result.enabled, false);
    });
});
