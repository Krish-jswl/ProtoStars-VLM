import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { PrivacyPipelineRunner } from '../extension/content/privacy_pipeline_runner.js';
import { PIIDetector } from '../extension/privacy/pii_detector.js';
import { PIIFusion } from '../extension/privacy/pii_fusion.js';
import { OCRTriggerPolicy } from '../extension/privacy/ocr_trigger.js';
import { OffscreenOCRProvider, TesseractOCR } from '../extension/privacy/tesseract_ocr.js';

class FakeCanvas {
    constructor(width = 200, height = 100) {
        this.width = width;
        this.height = height;
    }

    toDataURL() {
        return 'data:image/jpeg;base64,redacted-test-image';
    }
}

class FakeOCRProvider {
    constructor(results = []) {
        this.results = results;
        this.initializeCalls = 0;
        this.recognizeCalls = 0;
        this.failRecognition = false;
    }

    async initialize() {
        this.initializeCalls++;
    }

    async recognize() {
        this.recognizeCalls++;
        if (this.failRecognition) throw new Error('simulated OCR failure');
        return { results: this.results };
    }
}

function element({
    id = 'node',
    tag = 'div',
    text = '',
    visible = true,
    bbox = { x: 0, y: 0, width: 100, height: 20 }
} = {}) {
    return {
        id,
        tag,
        text,
        visible,
        enabled: true,
        bbox,
        inputType: '',
        autocomplete: '',
        placeholder: '',
        ariaLabel: '',
        name: '',
        label: '',
        options: []
    };
}

function makeRunner({ domElements, ocrProvider, gate } = {}) {
    const canvas = new FakeCanvas(200, 100);
    const redactor = {
        planRedaction: detections => detections.map((detection, index) => ({
            ...detection,
            token: `[${detection.type}_${index + 1}]`
        })),
        redactImage: async () => canvas,
        sanitizeDOM: elements => elements.map(el => ({
            ...el,
            bbox: { ...el.bbox }
        })),
        redactText: value => value
    };

    const pipeline = new PrivacyPipelineRunner({
        analyzer: { analyzeDOM: () => domElements || [] },
        faceDetector: { detectFaces: async () => [] },
        detector: new PIIDetector(),
        fusion: new PIIFusion(),
        redactor,
        gate: gate || {
            verify: () => ({ allowed: true, violations: [] })
        },
        ocrTrigger: new OCRTriggerPolicy(),
        ocrProvider: ocrProvider || new FakeOCRProvider()
    });

    // The capture/preprocessing boundary is browser-specific; keep these tests
    // focused on OCR selection, fusion, and fail-closed gate behavior.
    pipeline._preprocessImage = async () => canvas;
    return pipeline;
}

beforeEach(() => {
    const dom = new JSDOM('<!doctype html><title>OCR test</title>');
    global.window = dom.window;
    global.document = dom.window.document;
    Object.defineProperty(global.window, 'innerWidth', { value: 200, configurable: true });
    Object.defineProperty(global.window, 'innerHeight', { value: 100, configurable: true });
    global.chrome = {
        runtime: {
            lastError: null,
            sendMessage: (_message, callback) => callback({ dataUri: 'data:image/jpeg;base64,test' })
        }
    };
});

describe('Selective OCR privacy pipeline', () => {
    test('text-heavy pages skip OCR', async () => {
        const provider = new FakeOCRProvider();
        const domElements = Array.from({ length: 8 }, (_, index) => element({
            id: `text-${index}`,
            tag: 'p',
            text: 'This is ordinary text content on the page.'
        }));
        const pipeline = makeRunner({ domElements, ocrProvider: provider });

        const result = await pipeline.run();

        assert.strictEqual(result.allowed, true);
        assert.strictEqual(result.ocr.triggered, false);
        assert.strictEqual(provider.initializeCalls, 0);
        assert.strictEqual(provider.recognizeCalls, 0);
    });

    test('ordinary control-heavy pages without image content skip OCR', async () => {
        const provider = new FakeOCRProvider();
        const domElements = Array.from({ length: 10 }, (_, index) => element({
            id: `control-${index}`,
            tag: 'button',
            text: 'OK'
        }));
        const pipeline = makeRunner({ domElements, ocrProvider: provider });
        const result = await pipeline.run();

        assert.strictEqual(result.allowed, true);
        assert.strictEqual(result.ocr.triggered, false);
        assert.strictEqual(provider.initializeCalls, 0);
        assert.strictEqual(provider.recognizeCalls, 0);
    });

    test('canvas and image-heavy pages trigger OCR', async () => {
        for (const domElements of [
            [element({ id: 'canvas', tag: 'canvas' })],
            Array.from({ length: 4 }, (_, index) => element({
                id: `image-${index}`,
                tag: 'img'
            }))
        ]) {
            const provider = new FakeOCRProvider();
            const pipeline = makeRunner({ domElements, ocrProvider: provider });
            const result = await pipeline.run();

            assert.strictEqual(result.allowed, true);
            assert.strictEqual(result.ocr.triggered, true);
            assert.strictEqual(provider.initializeCalls, 1);
            assert.strictEqual(provider.recognizeCalls, 1);
        }
    });

    test('OCR PII reaches PII fusion', async () => {
        const provider = new FakeOCRProvider([
            {
                text: 'Contact alice@example.com for details',
                bbox: { x: 20, y: 20, width: 100, height: 18 },
                confidence: 0.99,
                source: 'OCR'
            }
        ]);
        const pipeline = makeRunner({
            domElements: [element({ id: 'canvas', tag: 'canvas' })],
            ocrProvider: provider
        });

        let fusedInput = [];
        const originalFuse = pipeline.fusion.fuse.bind(pipeline.fusion);
        pipeline.fusion.fuse = detections => {
            fusedInput = detections;
            return originalFuse(detections);
        };

        const result = await pipeline.run();

        assert.ok(fusedInput.some(detection =>
            detection.type === 'EMAIL' && detection.sources.includes('OCR')
        ));
        assert.ok(result.redactionPlan.some(detection => detection.type === 'EMAIL'));
    });

    test('OCR failure is blocked by the privacy gate', async () => {
        const provider = new FakeOCRProvider();
        provider.failRecognition = true;
        let gateCalls = 0;
        const gate = {
            verify: () => {
                gateCalls++;
                // A permissive gate must not override the OCR fail-closed rule.
                return { allowed: true, violations: [] };
            }
        };
        const pipeline = makeRunner({
            domElements: [element({ id: 'canvas', tag: 'canvas' })],
            ocrProvider: provider,
            gate
        });

        const result = await pipeline.run();

        assert.strictEqual(gateCalls, 1);
        assert.strictEqual(result.allowed, false);
        assert.ok(result.violations.some(violation =>
            violation.startsWith('OCR unavailable') && violation.endsWith('; request blocked')
        ));
        assert.strictEqual(result.sanitizedContext, undefined);
    });

    test('OCR worker is initialized once and reused across observations', async () => {
        const provider = new FakeOCRProvider();
        const pipeline = makeRunner({
            domElements: [element({ id: 'canvas', tag: 'canvas' })],
            ocrProvider: provider
        });

        await pipeline.run();
        await pipeline.run();

        assert.strictEqual(provider.initializeCalls, 1);
        assert.strictEqual(provider.recognizeCalls, 2);
    });

    test('offscreen OCR provider keeps the image in the local runtime', async () => {
        const originalChrome = globalThis.chrome;
        let sent = null;
        globalThis.chrome = {
            runtime: {
                lastError: null,
                sendMessage: (message, callback) => {
                    sent = message;
                    callback({
                        ok: true,
                        results: [{
                            text: 'local text',
                            bbox: { x: 1, y: 2, width: 10, height: 8 },
                            confidence: 0.8
                        }]
                    });
                }
            }
        };
        try {
            const provider = new OffscreenOCRProvider({ timeoutMs: 5000 });
            const result = await provider.recognize('data:image/jpeg;base64,LOCAL');
            assert.strictEqual(sent.type, 'LOCAL_OCR_RECOGNIZE');
            assert.strictEqual(sent.image, 'data:image/jpeg;base64,LOCAL');
            assert.strictEqual(result.results[0].text, 'local text');
        } finally {
            globalThis.chrome = originalChrome;
        }
    });

    test('TesseractOCR retains its worker across initialize calls', async () => {
        let createWorkerCalls = 0;
        let createWorkerOptions = null;
        let recognizeCalls = 0;
        const worker = {
            recognize: async () => {
                recognizeCalls++;
                return {
                    data: {
                        words: [{
                            text: 'safe text',
                            bbox: { x0: 1, y0: 2, x1: 11, y1: 7 },
                            confidence: 0.9
                        }]
                    }
                };
            },
            terminate: async () => {}
        };
        globalThis.Tesseract = {
            createWorker: async (_language, _oem, options) => {
                createWorkerCalls++;
                createWorkerOptions = options;
                return worker;
            }
        };
        global.chrome.runtime.getURL = path => `chrome-extension://test/${path}`;

        const provider = new TesseractOCR();
        await Promise.all([provider.initialize(), provider.initialize()]);
        await provider.recognize(new FakeCanvas());
        await provider.recognize(new FakeCanvas());

        assert.strictEqual(createWorkerCalls, 1);
        assert.strictEqual(recognizeCalls, 2);
        assert.strictEqual(createWorkerOptions?.workerBlobURL, false);
        assert.strictEqual(createWorkerOptions?.cacheMethod, 'none');
        await provider.dispose();
    });
});
