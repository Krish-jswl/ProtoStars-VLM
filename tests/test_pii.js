
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { PIIDetector } from '../extension/privacy/pii_detector.js';
import { PIIFusion } from '../extension/privacy/pii_fusion.js';

describe('PII Detection & Fusion Tests', () => {
    const detector = new PIIDetector();
    const fusion = new PIIFusion();

    test('Detects Password from DOM semantics', () => {
        const domEl = { inputType: 'password', id: 'pwd', tag: 'input', bbox: {x:10, y:10, width:100, height:20} };
        const res = detector.detectDOM(domEl);
        assert.strictEqual(res.length, 1);
        assert.strictEqual(res[0].type, 'PASSWORD');
        assert.strictEqual(res[0].confidence, 1.0);
    });

    test('Detects Email from DOM Regex', () => {
        const domEl = { inputType: 'text', id: 'bio', tag: 'div', text: 'Contact me at john@example.com', bbox: {x:0, y:0, width:50, height:10} };
        const res = detector.detectDOM(domEl);
        assert.ok(res.some(r => r.type === 'EMAIL' && r.sources.includes('DOM_REGEX')));
    });

    test('Fuses DOM and OCR overlap', () => {
        const domDetections = [
            { type: 'EMAIL', bbox: {x:10, y:10, width:100, height:20}, confidence: 0.9, sources: ['DOM'] }
        ];
        const ocrDetections = [
            { type: 'EMAIL', bbox: {x:12, y:11, width:95, height:18}, confidence: 0.7, sources: ['OCR'] }
        ];
        
        const all = [...domDetections, ...ocrDetections];
        const fused = fusion.fuse(all);
        
        assert.strictEqual(fused.length, 1); // Should merge
        assert.strictEqual(fused[0].type, 'EMAIL');
        assert.ok(fused[0].sources.includes('DOM'));
        assert.ok(fused[0].sources.includes('OCR'));
        assert.ok(fused[0].confidence > 0.9); // Combined confidence
    });

    test('Credit Card detection via regex', () => {
        const text = "My card is 4111 1111 1111 1111";
        const res = detector.extractRegex(text, {x:0,y:0,width:0,height:0}, 'OCR');
        assert.ok(res.some(r => r.type === 'CREDIT_CARD'));
    });

    test('Does not store raw value in output', () => {
        const text = "Secret email admin@admin.com";
        const res = detector.extractRegex(text, {x:0,y:0,width:0,height:0}, 'OCR');
        assert.strictEqual(res[0].value, undefined);
        assert.strictEqual(res[0].text, undefined);
    });

    test('Auth token detection', () => {
        const text = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI.eyJzdWIiOiIxMjM0NTY3ODkwIiw.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        const res = detector.extractRegex(text, {x:0,y:0,width:0,height:0}, 'OCR');
        assert.ok(res.some(r => r.type === 'AUTH_TOKEN'));
    });

    test('Non-PII text ignored', () => {
        const text = "Just a normal sentence with numbers like 123 and 456.";
        const res = detector.extractRegex(text, {x:0,y:0,width:0,height:0}, 'OCR');
        assert.strictEqual(res.length, 0); // Fails regexes for CC/Phone
    });
});
