
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { DOMAnalyzer } from '../extension/content/dom_analyzer.js';
import { PIIDetector } from '../extension/privacy/pii_detector.js';
import { PIIFusion } from '../extension/privacy/pii_fusion.js';
import { Redactor } from '../extension/privacy/redactor.js';
import { PrivacyGate } from '../extension/privacy/privacy_gate.js';
import { LocalSecretProvider } from '../extension/privacy/secret_provider.js';
import { OCRTriggerPolicy } from '../extension/privacy/ocr_trigger.js';

function setupDOM(html) {
    const dom = new JSDOM(html);
    global.document = dom.window.document;
    global.window = dom.window;
    for (const el of dom.window.document.querySelectorAll('*')) {
        el.getBoundingClientRect = () => ({ x:10, y:10, width:200, height:30 });
    }
    return dom;
}

describe('Phase 8B Regression Tests', () => {

    // 1. Email inbox text blocks now detected
    test('Email in div text block is detected', () => {
        setupDOM('<div id="row">priya.sharma@example.com</div>');
        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const detector = new PIIDetector();
        const detections = detector.detectAll(elements, []);
        assert.ok(detections.some(d => d.type === 'EMAIL'), 'Should detect email in text block');
    });

    test('Phone in paragraph text detected', () => {
        setupDOM('<p id="msg">Call me at +91 87654 32109</p>');
        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const detector = new PIIDetector();
        const detections = detector.detectAll(elements, []);
        assert.ok(detections.some(d => d.type === 'PHONE'), 'Should detect phone in text block');
    });

    // 2. "Save Button" NOT classified as PERSON
    test('"Save Button" not classified as PERSON', () => {
        setupDOM('<button id="btn">Save Button</button>');
        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const detector = new PIIDetector();
        const detections = detector.detectAll(elements, []);
        assert.ok(!detections.some(d => d.type === 'PERSON'), 'Normal UI text must not be PERSON');
    });

    test('"Submit Application" not classified as PERSON', () => {
        setupDOM('<button id="btn">Submit Application</button>');
        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const detector = new PIIDetector();
        const detections = detector.detectAll(elements, []);
        assert.ok(!detections.some(d => d.type === 'PERSON'), 'Button text must not be PERSON');
    });

    // 3. Password detection unchanged
    test('Password input still detected', () => {
        setupDOM('<input id="pw" type="password" />');
        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const detector = new PIIDetector();
        const detections = detector.detectAll(elements, []);
        assert.ok(detections.some(d => d.type === 'PASSWORD'), 'Password must still be detected');
    });

    // 4. Credit card still works
    test('Credit card still detected with Luhn-valid number', () => {
        setupDOM('<input id="cc" type="text" autocomplete="cc-number" value="4111111111111111" />');
        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const detector = new PIIDetector();
        const detections = detector.detectAll(elements, []);
        assert.ok(detections.some(d => d.type === 'CREDIT_CARD'), 'CC must be detected');
    });

    test('Random digits NOT classified as credit card (fails Luhn)', () => {
        setupDOM('<p id="t">Order number 1234567890123</p>');
        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const detector = new PIIDetector();
        const detections = detector.detectAll(elements, []);
        assert.ok(!detections.some(d => d.type === 'CREDIT_CARD'), 'Non-Luhn number must not be CC');
    });

    // 5. Auth token still works
    test('JWT auth token still detected', () => {
        const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI.eyJzdWIiOiIxMjM0NTY3ODkwIiw.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        setupDOM(`<p id="tok">${token}</p>`);
        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const detector = new PIIDetector();
        const detections = detector.detectAll(elements, []);
        assert.ok(detections.some(d => d.type === 'AUTH_TOKEN'), 'Auth token must be detected');
    });

    // 6. Privacy gate still blocks unknown types
    test('Privacy gate still blocks unknown detection type', () => {
        const gate = new PrivacyGate();
        const plan = [{ type: 'UNKNOWN', bbox: {x:0,y:0,width:10,height:10}, confidence: 0.9, token: '[UNKNOWN_1]' }];
        const result = gate.verify({ dom: [], scaleX:1, scaleY:1 }, { dom: [], image: null }, plan);
        assert.strictEqual(result.allowed, false);
    });

    // 7. Secret handling unchanged
    test('Secret provider still works', () => {
        const p = new LocalSecretProvider();
        p.set('email', 'test@test.com');
        assert.strictEqual(p.has('email'), true);
        assert.strictEqual(p.get('email'), 'test@test.com');
        assert.throws(() => p.set('ssn', '123'), /Unknown secret ref/);
    });

    // OCR trigger policy
    test('OCR trigger fires for canvas content', () => {
        setupDOM('<canvas id="cv" width="400" height="300"></canvas>');
        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const policy = new OCRTriggerPolicy();
        const result = policy.evaluate(elements);
        assert.strictEqual(result.shouldRunOCR, true);
    });

    test('OCR trigger does not fire for text-rich DOM', () => {
        setupDOM('<p>Hello world this is text</p><p>More text here too</p>');
        const analyzer = new DOMAnalyzer();
        const elements = analyzer.analyzeDOM();
        const policy = new OCRTriggerPolicy();
        const result = policy.evaluate(elements);
        assert.strictEqual(result.shouldRunOCR, false);
    });
});
