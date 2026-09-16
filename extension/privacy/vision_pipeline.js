
import { TesseractOCR } from './tesseract_ocr.js';

export class VisionPipeline {
    constructor(logger) {
        this.logger = logger;
        this.ocrProvider = new TesseractOCR(); // Can swap to WebGPU implementation later
        this.metrics = {
            screenshotMs: 0,
            preprocessingMs: 0,
            initMs: 0,
            inferenceMs: 0,
            totalMs: 0
        };
    }

    async preprocessImage(dataUri) {
        const start = performance.now();
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                // Downscale if too large to save OCR time
                const MAX_WIDTH = 1920;
                let width = img.width;
                let height = img.height;
                if (width > MAX_WIDTH) {
                    height = Math.floor(height * (MAX_WIDTH / width));
                    width = MAX_WIDTH;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                this.metrics.preprocessingMs = performance.now() - start;
                resolve(canvas);
            };
            img.src = dataUri;
        });
    }

    async runVision() {
        const totalStart = performance.now();
        this.logger.info("Starting Vision Pipeline");

        // 1. Capture Screenshot
        const captureStart = performance.now();
        const dataUri = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({type: 'CAPTURE_TAB'}, (response) => {
                if (response && response.dataUri) resolve(response.dataUri);
                else reject(new Error("Failed to capture tab"));
            });
        });
        this.metrics.screenshotMs = performance.now() - captureStart;

        // 2. Preprocess
        const processedCanvas = await this.preprocessImage(dataUri);

        // 3. Initialize OCR (Event driven, reuses worker)
        await this.ocrProvider.initialize();
        this.metrics.initMs = this.ocrProvider.initTimeMs; // Only non-zero on first load

        // 4. Run OCR Inference
        const { results, inferenceTimeMs } = await this.ocrProvider.recognize(processedCanvas);
        this.metrics.inferenceMs = inferenceTimeMs;

        this.metrics.totalMs = performance.now() - totalStart;
        
        this.logger.info("Vision Pipeline Complete", { metrics: this.metrics, ocrCount: results.length });
        
        return {
            ocrData: results,
            metrics: this.metrics
        };
    }
}
