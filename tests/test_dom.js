
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { DOMAnalyzer } from '../extension/content/dom_analyzer.js';

describe('DOM Analyzer Tests', () => {
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
});
