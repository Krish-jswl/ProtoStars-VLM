import { OCRProvider } from './ocr_provider.js';

/**
 * Tesseract-backed OCR provider.
 *
 * The worker is created lazily by initialize() and retained for the lifetime
 * of the content-script pipeline. A normal text-heavy observation never calls
 * either method, so OCR is both selective and reusable.
 */
export class OffscreenOCRProvider extends OCRProvider {
    constructor({ timeoutMs = 45000 } = {}) {
        super();
        this.timeoutMs = Math.max(1000, Number(timeoutMs) || 45000);
    }

    async initialize() {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
            throw new Error('OCR_OFFSCREEN_UNAVAILABLE');
        }
    }

    async recognize(image) {
        await this.initialize();
        const dataUri = typeof image === 'string'
            ? image
            : typeof image?.toDataURL === 'function'
                ? image.toDataURL('image/jpeg', 0.8)
                : '';
        if (!/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(dataUri)) {
            throw new Error('OCR_IMAGE_INVALID');
        }
        const response = await new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({
                    type: 'LOCAL_OCR_RECOGNIZE',
                    image: dataUri,
                    imageWidth: Number(image?.width) || 0,
                    imageHeight: Number(image?.height) || 0,
                    timeoutMs: this.timeoutMs
                }, result => {
                    void chrome.runtime.lastError;
                    resolve(result || { ok: false, reason: 'OCR_OFFSCREEN_UNAVAILABLE' });
                });
            } catch (_) {
                resolve({ ok: false, reason: 'OCR_OFFSCREEN_UNAVAILABLE' });
            }
        });
        if (!response?.ok) {
            throw new Error(String(response?.reason || 'OCR_OFFSCREEN_UNAVAILABLE'));
        }
        return {
            results: Array.isArray(response.results) ? response.results : [],
            inferenceTimeMs: Number(response.inferenceTimeMs) || 0
        };
    }

    async dispose() {
        // The offscreen worker is shared with the local vision runtime and is
        // disposed with that runtime; there is nothing page-local to tear down.
    }
}

export class TesseractOCR extends OCRProvider {
    constructor() {
        super();
        this.worker = null;
        this.initialized = false;
        this.initTimeMs = 0;
        this._initPromise = null;
    }

    async initialize() {
        if (this.initialized && this.worker) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._initialize();
        try {
            await this._initPromise;
        } finally {
            this._initPromise = null;
        }
    }

    async _initialize() {
        const start = performance.now();
        const tesseract = globalThis.Tesseract;
        if (!tesseract || typeof tesseract.createWorker !== 'function') {
            throw new Error('Tesseract.js is not loaded in this context.');
        }

        const runtime = globalThis.chrome?.runtime;
        if (!runtime || typeof runtime.getURL !== 'function') {
            throw new Error('Extension runtime is unavailable for OCR.');
        }

        const workerPath = runtime.getURL('lib/tesseract/worker.min.js');
        const corePath = runtime.getURL('lib/tesseract/tesseract-core.wasm.js');
        const langPath = runtime.getURL('lib/tesseract/');

        this.worker = await tesseract.createWorker('eng', 1, {
            workerPath,
            corePath,
            langPath,
            // Tesseract defaults to a blob: worker. A page with a strict CSP
            // (common on authenticated task apps) can reject that worker even
            // though the extension resource is available. Load the packaged
            // worker directly from the extension origin instead.
            workerBlobURL: false,
            cacheMethod: 'none',
            gzip: true
        });
        this.initialized = true;
        this.initTimeMs = performance.now() - start;
    }

    async recognize(image) {
        await this.initialize();
        if (!this.worker) {
            throw new Error('OCR worker is not initialized.');
        }

        const start = performance.now();
        // Request block output where supported. The extraction below also
        // handles older Tesseract builds that return `data.words` directly.
        const response = await this.worker.recognize(image, {}, {
            text: true,
            blocks: true
        });
        const data = response?.data || response || {};
        const results = this._extractResults(data, image);
        const inferenceTime = performance.now() - start;

        return {
            results,
            inferenceTimeMs: inferenceTime
        };
    }

    _extractResults(data, image) {
        const words = [];
        const addWord = (word) => {
            if (!word || typeof word.text !== 'string' || !word.text.trim()) return;
            const bbox = word.bbox;
            if (!bbox) return;
            words.push({
                text: word.text,
                bbox: Array.isArray(bbox)
                    ? bbox
                    : [bbox.x0, bbox.y0, bbox.x1 - bbox.x0, bbox.y1 - bbox.y0],
                confidence: Number.isFinite(word.confidence) ? word.confidence : 0,
                source: 'ocr'
            });
        };

        if (Array.isArray(data.words)) {
            data.words.forEach(addWord);
        }

        const visit = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node.words)) node.words.forEach(addWord);
            if (Array.isArray(node.lines)) node.lines.forEach(visit);
            if (Array.isArray(node.paragraphs)) node.paragraphs.forEach(visit);
            if (Array.isArray(node.blocks)) node.blocks.forEach(visit);
        };
        visit(data.blocks);

        if (words.length) return words;

        // Some Tesseract builds only return aggregate text. A full-image box
        // is intentionally conservative: it can over-redact, but cannot allow
        // OCR-detected PII to bypass the privacy gate.
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!text) return [];
        const width = Number(image?.width) || 0;
        const height = Number(image?.height) || 0;
        return [{
            text,
            bbox: [0, 0, width || 1, height || 1],
            confidence: 0,
            source: 'ocr'
        }];
    }

    async dispose() {
        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }
        this.initialized = false;
        this._initPromise = null;
    }
}
