
import { DOMAnalyzer } from './dom_analyzer.js';
import { ActionExecutor } from './action_executor.js';
import { PIIDetector } from '../privacy/pii_detector.js';
import { PIIFusion } from '../privacy/pii_fusion.js';
import { Redactor } from '../privacy/redactor.js';
import { PrivacyGate } from '../privacy/privacy_gate.js';
import { Logger } from '../shared/logger.js';
import { Config } from '../shared/config.js';

const logger = new Logger('PrivacyPipelineRunner');

export class PrivacyPipelineRunner {
    constructor() {
        this.analyzer = new DOMAnalyzer();
        this.executor = new ActionExecutor(Config);
        this.detector = new PIIDetector();
        this.fusion = new PIIFusion();
        this.redactor = new Redactor();
        this.gate = new PrivacyGate();
    }

    async run() {
        const timing = {};
        const t0 = performance.now();

        // 1. DOM analysis
        let t = performance.now();
        const domElements = this.analyzer.analyzeDOM();
        timing.dom = performance.now() - t;

        // 2. Screenshot capture via background
        t = performance.now();
        const dataUri = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }, (res) => {
                if (res?.dataUri) resolve(res.dataUri);
                else reject(new Error('Capture failed'));
            });
        });
        timing.screenshot = performance.now() - t;

        // 3. Preprocess image
        t = performance.now();
        const processedCanvas = await this._preprocessImage(dataUri);
        timing.preprocess = performance.now() - t;

        // 4. OCR (event-driven, no heavy NER yet)
        // Skipped in loop unless DOM text is insufficient; OCR provider is async and heavy.
        // For now, pass empty OCR results so PII detection is DOM+regex driven.
        const ocrResults = [];
        timing.ocr = 0;

        // 5. PII Detection + Fusion
        t = performance.now();
        const rawDetections = this.detector.detectAll(domElements, ocrResults);
        const fusedDetections = this.fusion.fuse(rawDetections);
        timing.pii = performance.now() - t;

        // 6. Redaction plan
        t = performance.now();
        const plan = this.redactor.planRedaction(fusedDetections);
        timing.plan = performance.now() - t;

        // 7. Visual Redaction
        t = performance.now();
        const redactedCanvas = await this.redactor.redactImage(processedCanvas, plan);
        timing.redact = performance.now() - t;

        // 8. DOM Sanitization
        const sanitizedDom = this.redactor.sanitizeDOM(domElements, plan);

        // 9. Build raw context for gate verification
        const rawContext = {
            dom: domElements,
            scaleX: 1,
            scaleY: 1
        };
        const sanitizedContext = {
            dom: sanitizedDom,
            image: redactedCanvas
        };

        // 10. Privacy Gate
        t = performance.now();
        const gateResult = this.gate.verify(rawContext, sanitizedContext, plan);
        timing.gate = performance.now() - t;

        timing.total = performance.now() - t0;

        if (!gateResult.allowed) {
            logger.warn('Privacy gate blocked', { violations: gateResult.violations });
            return { allowed: false, violations: gateResult.violations, timing };
        }

        // Build sanitized context payload for API
        const sanitizedPayload = {
            page: {
                url: window.location.href,
                title: document.title,
                viewport: { width: window.innerWidth, height: window.innerHeight }
            },
            dom: sanitizedDom.map(el => ({
                id: el.id || '',
                tag: el.tag || '',
                role: el.role || '',
                text: el.text || '',
                inputType: el.inputType || '',
                bbox: el.bbox || { x: 0, y: 0, width: 1, height: 1 },
                visible: !!el.visible,
                enabled: !!el.enabled
            })),
            image: redactedCanvas.toDataURL('image/jpeg', 0.8)
        };

        logger.info('Privacy pipeline passed', { timing });
        return { allowed: true, sanitizedContext: sanitizedPayload, timing };
    }

    async executeValidatedAction(action) {
        // Re-validate target freshness before execution
        const ALLOWED = new Set(['click', 'scroll', 'focus', 'select', 'wait', 'type_local']);
        if (!ALLOWED.has(action.type)) {
            return { success: false, error: 'Action type not allowed' };
        }

        if (action.type === 'wait') {
            const ms = Math.min(action.args?.ms || 500, 5000);
            await new Promise(r => setTimeout(r, ms));
            return { success: true };
        }

        if (action.type === 'type_local') {
            // Secret resolution happens locally; server only sends a ref
            // For now, reject if no local secret available
            return { success: false, error: 'type_local: no local secret store yet (Phase 7)' };
        }

        const selector = action.target ? `#${action.target}` : null;
        if (!selector) return { success: false, error: 'No target specified' };

        return this.executor.execute(action.type, selector, action.args || {});
    }

    async _preprocessImage(dataUri) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const MAX_WIDTH = 1920;
                let w = img.width, h = img.height;
                if (w > MAX_WIDTH) { h = Math.floor(h * MAX_WIDTH / w); w = MAX_WIDTH; }
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas);
            };
            img.src = dataUri;
        });
    }
}
