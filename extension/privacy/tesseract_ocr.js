
import { OCRProvider } from './ocr_provider.js';

export class TesseractOCR extends OCRProvider {
    constructor() {
        super();
        this.worker = null;
        this.initialized = false;
        this.initTimeMs = 0;
    }

    async initialize() {
        if (this.initialized) return;
        const start = performance.now();
        
        // Setup Tesseract worker
        // Using global Tesseract object if loaded via content script tag, 
        // or imported dynamically. In MV3 content script context, Tesseract is available from our bundled scripts.
        if (typeof Tesseract === 'undefined') {
            throw new Error("Tesseract.js not loaded in this context.");
        }

        const corePath = chrome.runtime.getURL('lib/tesseract/tesseract-core.wasm.js');
        const workerPath = chrome.runtime.getURL('lib/tesseract/worker.min.js');
        const langPath = chrome.runtime.getURL('lib/tesseract/'); // Must point to directory containing eng.traineddata.gz
        
        this.worker = await Tesseract.createWorker('eng', 1, {
            workerPath: workerPath,
            corePath: corePath,
            langPath: langPath
        });
        
        this.initialized = true;
        this.initTimeMs = performance.now() - start;
    }

    async recognize(image) {
        if (!this.initialized) await this.initialize();
        
        const start = performance.now();
        // image can be a canvas or base64. Tesseract handles canvas elements.
        const { data } = await this.worker.recognize(image);
        const inferenceTime = performance.now() - start;
        
        const results = data.words.map(word => ({
            text: word.text,
            bbox: [word.bbox.x0, word.bbox.y0, word.bbox.x1 - word.bbox.x0, word.bbox.y1 - word.bbox.y0],
            confidence: word.confidence,
            source: "ocr"
        }));
        
        return {
            results,
            inferenceTimeMs: inferenceTime
        };
    }

    async dispose() {
        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
            this.initialized = false;
        }
    }
}
