
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { DOMAnalyzer } from '../extension/content/dom_analyzer.js';
import { PIIDetector } from '../extension/privacy/pii_detector.js';
import { PIIFusion } from '../extension/privacy/pii_fusion.js';
import { Redactor } from '../extension/privacy/redactor.js';

// Known synthetic PII that must NEVER appear in outgoing payload
const KNOWN_PII = [
    'arjun.mehta@example.com',
    '+91 98765 43210',
    '4111 1111 1111 1111',
    'Arjun Mehta',
    '42 MG Road, Bengaluru'
];

describe('Network Privacy Tests', () => {
    test('Known PII absent from sanitized DOM payload', () => {
        const dom = new JSDOM(`<!DOCTYPE html>
            <input id="email" type="email" value="arjun.mehta@example.com" />
            <input id="phone" type="tel" value="+91 98765 43210" />
            <input id="card" type="text" autocomplete="cc-number" value="4111 1111 1111 1111" />
            <input id="name" type="text" autocomplete="name" value="Arjun Mehta" />
            <textarea id="addr" autocomplete="street-address">42 MG Road, Bengaluru</textarea>
        `);
        global.document = dom.window.document;
        global.window = dom.window;

        for (const el of dom.window.document.querySelectorAll('*')) {
            el.getBoundingClientRect = () => ({ x:10, y:10, width:200, height:30 });
        }

        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const detector = new PIIDetector();
        const fusion = new PIIFusion();
        const raw = detector.detectAll(elements, []);
        const fused = fusion.fuse(raw);
        const redactor = new Redactor();
        const plan = redactor.planRedaction(fused);
        const sanitized = redactor.sanitizeDOM(elements, plan);

        // Simulate outgoing payload
        const payload = JSON.stringify({
            dom: sanitized,
            image: 'base64_redacted_mock'
        });

        for (const pii of KNOWN_PII) {
            assert.ok(!payload.includes(pii), `PII "${pii}" must NOT appear in payload`);
        }
    });

    test('Password value never in payload', () => {
        const dom = new JSDOM(`<!DOCTYPE html><input id="pw" type="password" value="SuperSecret123" />`);
        global.document = dom.window.document;
        global.window = dom.window;
        dom.window.document.querySelector('#pw').getBoundingClientRect = () => ({ x:10, y:10, width:200, height:30 });

        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const detector = new PIIDetector();
        const fusion = new PIIFusion();
        const raw = detector.detectAll(elements, []);
        const fused = fusion.fuse(raw);
        const redactor = new Redactor();
        const plan = redactor.planRedaction(fused);
        const sanitized = redactor.sanitizeDOM(elements, plan);
        const payload = JSON.stringify(sanitized);

        assert.ok(!payload.includes('SuperSecret123'), 'Password must not appear in payload');
        assert.ok(payload.includes('[PASSWORD'), 'Password must be replaced with token');
    });

    test('Auth token absent from payload', () => {
        const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI.eyJzdWIiOiIxMjM0NTY3ODkwIiw.SflKxwRJSMeKKF';
        const dom = new JSDOM(`<!DOCTYPE html><div id="tok">${token}</div>`);
        global.document = dom.window.document;
        global.window = dom.window;
        dom.window.document.querySelector('#tok').getBoundingClientRect = () => ({ x:10, y:10, width:200, height:30 });

        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const detector = new PIIDetector();
        const raw = detector.detectAll(elements, []);
        const redactor = new Redactor();
        const plan = redactor.planRedaction(raw);
        const sanitized = redactor.sanitizeDOM(elements, plan);
        const payload = JSON.stringify(sanitized);

        assert.ok(!payload.includes(token), 'Auth token must not appear in payload');
    });
});
