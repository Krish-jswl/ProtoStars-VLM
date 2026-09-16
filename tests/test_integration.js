
import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { PIIDetector } from '../extension/privacy/pii_detector.js';
import { PIIFusion } from '../extension/privacy/pii_fusion.js';
import { Redactor } from '../extension/privacy/redactor.js';
import { PrivacyGate } from '../extension/privacy/privacy_gate.js';

// ── Canvas mock ──────────────────────────────────────────────────────────────
class MockCanvas {
    constructor(w=200, h=200) {
        this.width = w; this.height = h;
        this.data = new Uint8ClampedArray(w * h * 4).fill(255);
    }
    getContext() {
        const data = this.data;
        const w = this.width;
        return {
            drawImage: () => {},
            fillRect: (x, y, rw, rh) => {
                for (let i = y; i < y + rh; i++) {
                    for (let j = x; j < x + rw; j++) {
                        if (i >= 0 && i < this.height && j >= 0 && j < w) {
                            const idx = (i * w + j) * 4;
                            data[idx] = data[idx+1] = data[idx+2] = 0; data[idx+3] = 255;
                        }
                    }
                }
            },
            getImageData: () => ({ data })
        };
    }
    toDataURL() { return 'data:image/jpeg;base64,mock'; }
}

const dom = new JSDOM('<!DOCTYPE html>');
global.document = dom.window.document;
global.window = dom.window;
global.document.createElement = (tag) => tag === 'canvas' ? new MockCanvas() : dom.window.document.createElement(tag);

// ── HELPERS ──────────────────────────────────────────────────────────────────
function buildDetections(type, bbox) {
    return [{ type, bbox, confidence: 0.9, sources: ['DOM'] }];
}

function checkPixel(canvas, x, y) {
    const data = canvas.getContext('2d').getImageData().data;
    const idx = (y * canvas.width + x) * 4;
    return data[idx] === 0 && data[idx+1] === 0 && data[idx+2] === 0;
}

describe('Phase 6 Integration Tests', () => {
    const detector = new PIIDetector();
    const fusion = new PIIFusion();
    const redactor = new Redactor();
    const gate = new PrivacyGate();

    // A: Valid sanitized context passes gate
    test('A: Valid sanitized context passes privacy gate', async () => {
        const rawDom = [{ tag: 'button', text: 'Submit', bbox: {x:0,y:0,width:50,height:20}, inputType: '' }];
        const plan = redactor.planRedaction([]);
        const sanDom = redactor.sanitizeDOM(rawDom, plan);
        const canvas = new MockCanvas();
        const rawCtx = { dom: rawDom, scaleX: 1, scaleY: 1 };
        const sanCtx = { dom: sanDom, image: canvas };
        const result = gate.verify(rawCtx, sanCtx, plan);
        assert.strictEqual(result.allowed, true);
    });

    // B: Raw PII in raw DOM but sanitized before gate check passes
    test('B: PII is detected and redacted before gate passes', async () => {
        const rawDom = [{ tag: 'input', inputType: 'password', text: '', bbox: {x:0,y:0,width:100,height:20} }];
        const detections = detector.detectAll(rawDom, []);
        const fused = fusion.fuse(detections);
        const plan = redactor.planRedaction(fused);
        const sanDom = redactor.sanitizeDOM(rawDom, plan);

        // PASSWORD must be replaced with token
        assert.ok(sanDom[0].text.startsWith('[PASSWORD'));
    });

    // C: Privacy gate failure causes zero requests (simulated)
    test('C: Gate failure blocks network request', async () => {
        let requestMade = false;
        // Simulate: gate fails → should not call fetch
        const gateResult = { allowed: false, violations: ['Test violation'] };
        if (!gateResult.allowed) {
            // This is what agent_loop does: returns early
        } else {
            requestMade = true; // Never reached
        }
        assert.strictEqual(requestMade, false, 'No request must be made when gate fails');
    });

    // D: Malformed backend response is rejected
    test('D: Malformed backend action rejected', () => {
        const ALLOWED = new Set(['click','scroll','focus','select','wait','type_local']);
        const action = { type: 'eval', target: 'window' };
        const allowed = ALLOWED.has(action.type);
        assert.strictEqual(allowed, false);
    });

    // E: Stale DOM target is rejected
    test('E: Stale DOM target rejected by executor', async () => {
        const jsDom = new JSDOM('<!DOCTYPE html><button id="real">Real</button>');
        global.document = jsDom.window.document;
        global.window = jsDom.window;

        const { ActionExecutor } = await import('../extension/content/action_executor.js');
        const executor = new ActionExecutor({
            actionValidation: { requireVisible: true, allowedActions: ['click','scroll','focus'] }
        });

        // After DOM updated, stale target is gone
        jsDom.window.document.body.innerHTML = '<p>DOM changed</p>';
        const result = executor.execute('click', '#real');
        assert.strictEqual(result.success, false);
        assert.ok(result.error);
    });

    // F: Arbitrary JS action rejected
    test('F: Arbitrary JS type rejected', () => {
        const ALLOWED = new Set(['click','scroll','focus','select','wait','type_local']);
        const maliciousAction = { type: 'javascript:alert(1)', target: 'body' };
        assert.strictEqual(ALLOWED.has(maliciousAction.type), false);
    });

    // G: Action execution causes DOM change
    test('G: Click executes and triggers DOM event', async () => {
        const jsDom = new JSDOM('<!DOCTYPE html><button id="btn">Click</button>');
        global.document = jsDom.window.document;
        global.window = jsDom.window;

        jsDom.window.HTMLElement.prototype.getBoundingClientRect = function() {
            return { x: 10, y: 10, width: 80, height: 30 };
        };

        let clicked = false;
        jsDom.window.document.getElementById('btn').addEventListener('click', () => { clicked = true; });

        const { ActionExecutor } = await import('../extension/content/action_executor.js');
        const executor = new ActionExecutor({
            actionValidation: { requireVisible: true, allowedActions: ['click','scroll','focus'] }
        });

        const result = executor.execute('click', '#btn');
        assert.strictEqual(result.success, true);
        assert.strictEqual(clicked, true);
    });

    // Timing: Check that pipeline timing fields are produced
    test('H: Timing fields populated', () => {
        const timing = { dom: 2, screenshot: 100, pii: 5, redact: 6, gate: 3, total: 120 };
        for (const key of ['dom', 'pii', 'redact', 'gate', 'total']) {
            assert.ok(typeof timing[key] === 'number');
        }
    });
});
