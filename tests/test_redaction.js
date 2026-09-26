
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { Redactor } from '../extension/privacy/redactor.js';
import { PrivacyGate } from '../extension/privacy/privacy_gate.js';

// Setup DOM and Canvas mock for Node
const dom = new JSDOM(`<!DOCTYPE html>`);
global.document = dom.window.document;
global.window = dom.window;

// Polyfill minimal canvas Context2D for the tests
class MockCanvas {
    constructor(w = 1000, h = 1000) {
        this._width = w;
        this._height = h;
        this.reallocate();
    }
    get width() { return this._width; }
    set width(val) { this._width = val; this.reallocate(); }
    get height() { return this._height; }
    set height(val) { this._height = val; this.reallocate(); }

    reallocate() {
        this.data = new Uint8ClampedArray(this._width * this._height * 4);
        // fill with white to test redaction
        for (let i = 0; i < this.data.length; i++) this.data[i] = 255;
    }

    getContext() {
        let fillStyle = 'black';
        return {
            set fillStyle(val) { fillStyle = val; },
            get fillStyle() { return fillStyle; },
            drawImage: () => {},
            fillRect: (x, y, w, h) => {
                const isBlack = (fillStyle === 'black' || fillStyle === '#000000' || fillStyle === '#000');
                const val = isBlack ? 0 : 255;
                for (let i = y; i < y + h; i++) {
                    for (let j = x; j < x + w; j++) {
                        if (i >= 0 && i < this._height && j >= 0 && j < this._width) {
                            const idx = (i * this._width + j) * 4;
                            this.data[idx] = val;     // R
                            this.data[idx+1] = val;   // G
                            this.data[idx+2] = val;   // B
                            this.data[idx+3] = 255; // A
                        }
                    }
                }
            },
            getImageData: () => ({ data: this.data })
        };
    }
}
global.document.createElement = (tag) => {
    if (tag === 'canvas') return new MockCanvas(1000, 1000);
    return dom.window.document.createElement(tag);
};

describe('Redaction & Privacy Gate Tests', () => {
    const redactor = new Redactor();
    const gate = new PrivacyGate();

    test('Redaction Planner replaces types with semantic tokens', () => {
        const detections = [
            { type: 'EMAIL', bbox: {x:0,y:0,width:10,height:10}, confidence: 0.9 },
            { type: 'EMAIL', bbox: {x:20,y:20,width:10,height:10}, confidence: 0.9 },
            { type: 'PHONE', bbox: {x:40,y:40,width:10,height:10}, confidence: 0.9 }
        ];
        const planned = redactor.planRedaction(detections);
        assert.strictEqual(planned[0].token, '[EMAIL_1]');
        assert.strictEqual(planned[1].token, '[EMAIL_2]');
        assert.strictEqual(planned[2].token, '[PHONE_1]');
    });

    test('DOM Sanitization removes sensitive values', () => {
        const rawDom = [
            { tag: 'div', text: 'john@example.com', bbox: {x:0,y:0,width:50,height:20} },
            { inputType: 'password', text: 'secret', bbox: {x:100,y:100,width:50,height:20} }
        ];
        const plan = redactor.planRedaction([
            { type: 'EMAIL', bbox: {x:0,y:0,width:50,height:20}, confidence: 0.9 }
        ]);
        
        const sanitized = redactor.sanitizeDOM(rawDom, plan);
        assert.strictEqual(sanitized[0].text, '[EMAIL_1]');
        assert.strictEqual(sanitized[1].text, '[PASSWORD_1]');
    });

    test('Visual Redaction covers image', async () => {
        const rawCanvas = createMockCanvas(100, 100);
        const plan = redactor.planRedaction([
            { type: 'PHONE', bbox: {x:10,y:10,width:20,height:20}, confidence: 0.9 }
        ]);
        
        const redactedCanvas = await redactor.redactImage(rawCanvas, plan);
        
        const rawCtx = rawContext(redactedCanvas);
        // Center pixel should be black
        const r = checkPixel(redactedCanvas, 20, 20);
        assert.strictEqual(r, true, "Center pixel should be black");
    });

    test('Privacy Gate allows fully redacted context', async () => {
        const rawCanvas = createMockCanvas(100, 100);
        const plan = redactor.planRedaction([
            { type: 'EMAIL', bbox: {x:10,y:10,width:20,height:20}, confidence: 0.9 }
        ]);
        const redactedCanvas = await redactor.redactImage(rawCanvas, plan);
        
        const rawDom = [{ tag: 'div', text: 'john@example.com', bbox: {x:10,y:10,width:20,height:20} }];
        const sanDom = redactor.sanitizeDOM(rawDom, plan);
        
        const rawContext = { dom: rawDom, scaleX: 1, scaleY: 1 };
        const sanContext = { dom: sanDom, image: redactedCanvas };
        
        const res = gate.verify(rawContext, sanContext, plan);
        assert.strictEqual(res.allowed, true);
    });

    test('Privacy Gate blocks on incomplete visual redaction', async () => {
        const rawCanvas = createMockCanvas(100, 100);
        const plan = redactor.planRedaction([
            { type: 'EMAIL', bbox: {x:10,y:10,width:20,height:20}, confidence: 0.9 }
        ]);
        
        // Mock a failure by passing a non-redacted canvas
        const sanContext = { dom: [], image: createMockCanvas(100, 100) };
        const res = gate.verify({ dom: [], scaleX:1, scaleY:1 }, sanContext, plan);
        
        assert.strictEqual(res.allowed, false);
        assert.ok(res.violations[0].includes("Incomplete visual redaction"));
    });

    test('Privacy Gate blocks unknown detection type', async () => {
        const plan = redactor.planRedaction([
            { type: 'WEIRD_TYPE', bbox: {x:10,y:10,width:20,height:20}, confidence: 0.9 }
        ]);
        const res = gate.verify({ dom: [], scaleX:1, scaleY:1 }, { dom: [], image: createMockCanvas(100, 100) }, plan);
        
        assert.strictEqual(res.allowed, false);
        assert.ok(res.violations[0].includes("Unknown/unhandled sensitive detection"));
    });

    test('Coordinate resizing is handled', async () => {
        const rawCanvas = createMockCanvas(200, 200); // 2x scaled image
        const plan = redactor.planRedaction([
            { type: 'CREDIT_CARD', bbox: {x:10,y:10,width:20,height:20}, confidence: 0.9 }
        ]);
        // Bbox is from original 100x100 DOM. We scale by 2.0
        const redactedCanvas = await redactor.redactImage(rawCanvas, plan, 2.0, 2.0);
        
        const res = gate.verify({ dom: [], scaleX:2.0, scaleY:2.0 }, { dom: [], image: redactedCanvas }, plan);
        assert.strictEqual(res.allowed, true);
        
        // Pixel at 2x center (30, 30) should be redacted
        assert.strictEqual(checkPixel(redactedCanvas, 30, 30), true);
    });
});

function rawContext(canvas) { return canvas; }
function checkPixel(canvas, x, y) {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const idx = (y * canvas.width + x) * 4;
    return data[idx] === 0 && data[idx+1] === 0 && data[idx+2] === 0;
}

function createMockCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    return c;
}
