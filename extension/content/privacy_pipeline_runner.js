
import { DOMAnalyzer } from './dom_analyzer.js';
import { ActionExecutor } from './action_executor.js';
import { FaceDetectorService } from "../privacy/face_detector.js";
import { PIIDetector } from '../privacy/pii_detector.js';
import { PIIFusion } from '../privacy/pii_fusion.js';
import { Redactor } from '../privacy/redactor.js';
import { PrivacyGate } from '../privacy/privacy_gate.js';
import { LocalSecretProvider } from '../privacy/secret_provider.js';
import { Logger } from '../shared/logger.js';
import { Config } from '../shared/config.js';

const logger = new Logger('PrivacyPipelineRunner');

export class PrivacyPipelineRunner {
    constructor() {
        this.analyzer = new DOMAnalyzer();
        this.executor = new ActionExecutor(Config);
        this.faceDetector = new FaceDetectorService();
        this.detector = new PIIDetector();
        this.fusion = new PIIFusion();
        this.redactor = new Redactor();
        this.gate = new PrivacyGate();
        this.secretProvider = new LocalSecretProvider();
        this._secretsLoaded = false;
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
                if (chrome.runtime.lastError) {
                    reject(new Error('Capture failed: ' + chrome.runtime.lastError.message));
                } else if (res?.dataUri) {
                    resolve(res.dataUri);
                } else if (res?.error) {
                    reject(new Error('Capture failed: ' + res.error));
                } else {
                    reject(new Error('Capture failed: no dataUri returned'));
                }
            });
        });
        timing.screenshot = performance.now() - t;

        // 3. Preprocess image
        t = performance.now();
        const processedCanvas = await this._preprocessImage(dataUri);
        timing.preprocess = performance.now() - t;

        // 4. OCR — skipped in loop for now
        const ocrResults = [];
        timing.ocr = 0;

        // Calculate scaling factors between DOM (CSS pixels) and the captured image (physical/preprocessed pixels)
        const scaleX = processedCanvas.width / window.innerWidth;
        const scaleY = processedCanvas.height / window.innerHeight;

        // 4.5. Face Detection
        t = performance.now();
        const faceDetections = await this.faceDetector.detectFaces(processedCanvas, scaleX, scaleY);
        timing.face = performance.now() - t;

        // 5. PII Detection + Fusion
        t = performance.now();
        const rawDetections = this.detector.detectAll(domElements, ocrResults);
        rawDetections.push(...faceDetections);
        const fusedDetections = this.fusion.fuse(rawDetections);
        timing.pii = performance.now() - t;

        // 6. Redaction plan
        t = performance.now();
        const plan = this.redactor.planRedaction(fusedDetections);
        timing.plan = performance.now() - t;



        // 7. Visual Redaction
        t = performance.now();
        const redactedCanvas = await this.redactor.redactImage(processedCanvas, plan, scaleX, scaleY);
        timing.redact = performance.now() - t;

        // 8. DOM Sanitization
        const sanitizedDom = this.redactor.sanitizeDOM(domElements, plan);

        // 9. Build raw context for gate verification
        const rawContext = { dom: domElements, scaleX, scaleY };
        const sanitizedContext = { dom: sanitizedDom, image: redactedCanvas };

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

        logger.info('Privacy pipeline passed', { timing, detections: plan.length });
        return { allowed: true, sanitizedContext: sanitizedPayload, timing, redactionPlan: plan };
    }

    async executeValidatedAction(action) {
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
            await this._ensureSecretsLoaded();
            // Non-secret text typing (e.g. note title) uses args.text
            if (!action.args?.secret_ref && typeof action.args?.text === 'string') {
                return this._executeTypeText(action);
            }
            return this._executeTypeLocal(action);
        }

        const selector = ActionExecutor.selectorForTarget(action.target);
        if (!selector && action.type !== 'scroll') {
            return { success: false, error: 'No target specified' };
        }
        return this.executor.execute(action.type, selector || 'body', action.args || {});
    }

    /** Normalize backend secret_ref values (password / PASSWORD_1 / [PASSWORD_1]). */
    _normalizeSecretRef(ref) {
        if (!ref || typeof ref !== 'string') return null;
        const cleaned = ref.trim().replace(/^\[|\]$/g, '');
        const lower = cleaned.toLowerCase();
        const base = lower.replace(/_\d+$/, '');
        if (['email', 'phone', 'username', 'password'].includes(base)) return base;
        return lower;
    }

    async _ensureSecretsLoaded() {
        if (this._secretsLoaded) return;
        this._secretsLoaded = true;
        try {
            if (typeof chrome !== 'undefined' && chrome.storage?.local) {
                const data = await chrome.storage.local.get(['pva_secrets']);
                const secrets = data.pva_secrets || {};
                for (const [key, value] of Object.entries(secrets)) {
                    if (typeof value === 'string' && value.length > 0) {
                        try { this.secretProvider.set(key, value); } catch (_) { /* unknown ref */ }
                    }
                }
            }
        } catch (_) { /* storage unavailable */ }
    }

    /** Apply secrets from a SET_SECRETS message (in-memory + optional persist). */
    setSecrets(secrets, persist = true) {
        if (!secrets || typeof secrets !== 'object') return;
        for (const [key, value] of Object.entries(secrets)) {
            if (typeof value === 'string' && value.length > 0) {
                try { this.secretProvider.set(key, value); } catch (_) { /* unknown ref */ }
            }
        }
        this._secretsLoaded = true;
        if (persist && typeof chrome !== 'undefined' && chrome.storage?.local) {
            chrome.storage.local.get(['pva_secrets'], (data) => {
                const merged = { ...(data.pva_secrets || {}), ...secrets };
                chrome.storage.local.set({ pva_secrets: merged });
            });
        }
    }

    _executeTypeText(action) {
        const selector = ActionExecutor.selectorForTarget(action.target);
        if (!selector) return { success: false, error: 'No target specified' };

        let element;
        try {
            element = document.querySelector(selector);
        } catch (e) {
            return { success: false, error: 'Invalid selector' };
        }

        if (!element) return { success: false, error: 'Element not found' };
        const tag = element.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') {
            return { success: false, error: 'Target must be input or textarea' };
        }
        if (element.disabled || element.readOnly) {
            return { success: false, error: 'Target is not editable' };
        }
        // Never allow plaintext typing into password fields — must use secret_ref
        if ((element.type || '').toLowerCase() === 'password') {
            return { success: false, error: 'Use secret_ref for password fields' };
        }

        LocalSecretProvider.insertSecret(element, String(action.args.text));
        return { success: true };
    }

    _executeTypeLocal(action) {
        const secretRef = this._normalizeSecretRef(action.args?.secret_ref);
        if (!secretRef) {
            return { success: false, error: 'Missing secret_ref' };
        }

        if (!this.secretProvider.has(secretRef)) {
            // Never reveal which refs exist in error messages
            return { success: false, error: 'Secret not available' };
        }

        const selector = ActionExecutor.selectorForTarget(action.target);
        if (!selector) return { success: false, error: 'No target specified' };

        let element;
        try {
            element = document.querySelector(selector);
        } catch(e) {
            return { success: false, error: 'Invalid selector' };
        }

        const validation = LocalSecretProvider.validateTarget(element, secretRef);
        if (!validation.valid) {
            return { success: false, error: validation.reason };
        }

        // Resolve and insert — secret value stays in this function scope only
        const value = this.secretProvider.get(secretRef);
        if (!value) return { success: false, error: 'Secret not available' };

        LocalSecretProvider.insertSecret(element, value);

        // Return success. NEVER include secret value in result.
        return { success: true };
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
