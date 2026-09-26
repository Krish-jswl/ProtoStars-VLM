
import { DOMAnalyzer } from './dom_analyzer.js';
import { ActionExecutor } from './action_executor.js';
import { containsSensitiveLiteral, prepareLocalDomMetadata } from '../local_agent/local_vision_protocol.js';
import { FaceDetectorService } from "../privacy/face_detector.js";
import { PIIDetector } from '../privacy/pii_detector.js';
import { PIIFusion } from '../privacy/pii_fusion.js';
import { Redactor } from '../privacy/redactor.js';
import { PrivacyGate } from '../privacy/privacy_gate.js';
import { LocalSecretProvider } from '../privacy/secret_provider.js';
import { OCRTriggerPolicy } from '../privacy/ocr_trigger.js';
import { OffscreenOCRProvider } from '../privacy/tesseract_ocr.js';
import { Logger } from '../shared/logger.js';
import { Config } from '../shared/config.js';

const logger = new Logger('PrivacyPipelineRunner');

function textFingerprint(value) {
    const normalized = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    let hash = 2166136261;
    for (let index = 0; index < normalized.length; index++) {
        hash ^= normalized.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export class PrivacyPipelineRunner {
    constructor(options = {}) {
        this.analyzer = options.analyzer || new DOMAnalyzer();
        this.executor = options.executor || new ActionExecutor(Config);
        this.faceDetector = options.faceDetector || new FaceDetectorService();
        this.detector = options.detector || new PIIDetector();
        this.fusion = options.fusion || new PIIFusion();
        this.redactor = options.redactor || new Redactor();
        this.gate = options.gate || new PrivacyGate();
        this.ocrTrigger = options.ocrTrigger || new OCRTriggerPolicy();
        // OCR runs in the extension offscreen document. A worker created from
        // a page content script is rejected by strict page CSP on some task
        // apps, which would unnecessarily fail the privacy gate closed.
        this.ocrProvider = options.ocrProvider || new OffscreenOCRProvider({
            timeoutMs: options.ocrTimeoutMs || 45000
        });
        this.secretProvider = new LocalSecretProvider();
        this._secretsLoaded = false;
        this._recentTypeWrites = new WeakMap();
        this._ocrInitialized = false;
        this._ocrInitPromise = null;
    }

    async run() {
        const timing = {};
        const t0 = performance.now();

        // 1. DOM analysis
        let t = performance.now();
        const domElements = this.analyzer.analyzeDOM();
        timing.dom = performance.now() - t;

        // 2. Cheap DOM PII detection happens before deciding whether OCR is
        // worthwhile. This keeps text-heavy pages on the fast path.
        t = performance.now();
        const domDetections = typeof this.detector.detectDOM === 'function'
            ? domElements.flatMap(element => this.detector.detectDOM(element))
            : this.detector.detectAll(domElements, []);
        timing.domPii = performance.now() - t;

        // 3. Evaluate the selective OCR trigger. No worker initialization or
        // OCR inference occurs when the page is sufficiently text-heavy.
        t = performance.now();
        const ocrTrigger = this.ocrTrigger.evaluate(domElements);
        timing.ocrTrigger = performance.now() - t;

        // 4. Screenshot capture via background
        t = performance.now();
        const dataUri = await this._captureScreenshot();
        timing.screenshot = performance.now() - t;

        // 5. Preprocess image
        t = performance.now();
        const processedCanvas = await this._preprocessImage(dataUri);
        timing.preprocess = performance.now() - t;

        const scaleX = (processedCanvas.width || 1) / Math.max(1, window.innerWidth || 1);
        const scaleY = (processedCanvas.height || 1) / Math.max(1, window.innerHeight || 1);

        let ocrResults = [];
        let ocrFailure = null;
        if (ocrTrigger?.shouldRunOCR) {
            t = performance.now();
            try {
                await this._ensureOCRInitialized();
                const rawOCR = await this.ocrProvider.recognize(processedCanvas);
                ocrResults = this._normalizeOCRResults(rawOCR, scaleX, scaleY, processedCanvas);
            } catch (error) {
                // Fail closed below. Keep the diagnostic categorical so the
                // UI/logs never receive provider exception text or page data.
                ocrFailure = { reason: this._safeOCRFailureReason(error) };
                logger.warn('OCR failed; privacy gate will fail closed', {
                    reason: ocrFailure.reason
                });
            }
            timing.ocr = performance.now() - t;
        } else {
            timing.ocr = 0;
        }

        // 6. Turn OCR words into PII detections and fuse them with cheap DOM
        // detections. OCR coordinates are normalized back to CSS pixels.
        t = performance.now();
        const ocrDetections = ocrResults.flatMap(result => this.detector.detectOCR(result));
        const rawDetections = [...domDetections, ...ocrDetections];

        // Face detection remains independent of OCR and is included in the
        // same fusion/redaction/gate path.
        t = performance.now();
        const faceDetections = await this.faceDetector.detectFaces(processedCanvas, scaleX, scaleY);
        timing.face = performance.now() - t;
        rawDetections.push(...faceDetections);

        const fusedDetections = this.fusion.fuse(rawDetections);
        timing.pii = performance.now() - t;

        // 7. Redaction plan
        t = performance.now();
        const plan = this.redactor.planRedaction(fusedDetections);
        timing.plan = performance.now() - t;

        // 8. Visual Redaction
        t = performance.now();
        const redactedCanvas = await this.redactor.redactImage(processedCanvas, plan, scaleX, scaleY);
        timing.redact = performance.now() - t;

        // 9. DOM Sanitization
        const sanitizedDom = this.redactor.sanitizeDOM(domElements, plan);

        // 10. Build raw context for gate verification
        const rawContext = { dom: domElements, scaleX, scaleY };
        const sanitizedContext = { dom: sanitizedDom, image: redactedCanvas };

        // 11. Privacy Gate. OCR failures are explicitly appended after the
        // normal gate runs, so even a permissive/custom gate cannot allow a
        // request when required OCR failed.
        t = performance.now();
        const gateResult = this.gate.verify(rawContext, sanitizedContext, plan) || {
            allowed: false,
            violations: ['Privacy gate returned no result']
        };
        if (ocrFailure) {
            gateResult.allowed = false;
            const reasonSuffix = ocrFailure.reason ? ` (${ocrFailure.reason})` : '';
            gateResult.violations = [
                ...(gateResult.violations || []),
                `OCR unavailable${reasonSuffix}; request blocked`
            ];
        }
        timing.gate = performance.now() - t;
        timing.total = performance.now() - t0;

        if (!gateResult.allowed) {
            logger.warn('Privacy gate blocked', { violations: gateResult.violations });
            return {
                allowed: false,
                violations: gateResult.violations,
                timing,
                ocr: {
                    triggered: !!ocrTrigger?.shouldRunOCR,
                    resultCount: ocrResults.length,
                    failureReason: ocrFailure?.reason || null
                }
            };
        }

        // Build sanitized context payload for API
        const sanitizedPayload = {
            page: {
                // URLs and titles can contain PII in query parameters or page
                // text even when the visible DOM is clean.
                url: this.redactor.redactText(window.location.href),
                title: this.redactor.redactText(document.title),
                viewport: { width: window.innerWidth, height: window.innerHeight }
            },
            dom: sanitizedDom.map(el => ({
                id: el.id || '',
                tag: el.tag || '',
                role: el.role || '',
                text: el.text || '',
                inputType: el.inputType || '',
                autocomplete: el.autocomplete || '',
                placeholder: el.placeholder || '',
                ariaLabel: el.ariaLabel || '',
                name: el.name || '',
                title: el.title || '',
                testId: el.testId || '',
                label: el.label || '',
                ariaExpanded: el.ariaExpanded || '',
                ariaSelected: el.ariaSelected || '',
                ariaChecked: el.ariaChecked || '',
                ariaCurrent: el.ariaCurrent || '',
                ariaPressed: el.ariaPressed || '',
                ariaHasPopup: el.ariaHasPopup || '',
                options: Array.isArray(el.options) ? el.options.slice(0, 100) : [],
                bbox: el.bbox || { x: 0, y: 0, width: 1, height: 1 },
                visible: !!el.visible,
                enabled: !!el.enabled,
                readOnly: !!el.readOnly            })),
            image: redactedCanvas.toDataURL('image/jpeg', 0.8)
        };

        logger.info('Privacy pipeline passed', { timing, detections: plan.length });
        return {
            allowed: true,
            sanitizedContext: sanitizedPayload,
            timing,
            redactionPlan: plan,
            ocr: {
                triggered: !!ocrTrigger?.shouldRunOCR,
                resultCount: ocrResults.length,
                reason: ocrTrigger?.reason || ''
            }
        };
    }

    /**
     * Capture a raw screenshot and bounded local metadata for the offscreen
     * VLM. This path never contacts the backend and never returns raw DOM
     * values; the screenshot is used only by the extension-local worker.
     */
    async observeForLocalVision() {
        const started = performance.now();
        const domElements = this.analyzer.analyzeDOM();
        const dataUri = await this._captureScreenshot();
        const canvas = await this._preprocessImage(dataUri);
        const viewportWidth = globalThis.window?.innerWidth || canvas.width || 1;
        const viewportHeight = globalThis.window?.innerHeight || canvas.height || 1;
        const scaleX = (canvas.width || 1) / Math.max(1, viewportWidth);
        const scaleY = (canvas.height || 1) / Math.max(1, viewportHeight);
        let ocrResults = [];
        let ocrStatus = 'not-needed';

        try {
            const trigger = this.ocrTrigger?.evaluate?.(domElements);
            if (trigger?.shouldRunOCR) {
                await this._ensureOCRInitialized();
                const rawOCR = await this.ocrProvider.recognize(canvas);
                ocrResults = this._normalizeOCRResults(rawOCR, scaleX, scaleY, canvas);
                ocrStatus = 'available';
            }
        } catch (_) {
            // OCR is an optional local hint for visual reasoning. The server
            // privacy path remains fail-closed if its own OCR requirement fails.
            ocrStatus = 'unavailable';
        }

        return {
            dom: prepareLocalDomMetadata(domElements, 80),
            image: canvas.toDataURL('image/jpeg', 0.82),
            ocr: this._safeLocalOCR(ocrResults),
            ocrStatus,
            timing: {
                total: performance.now() - started
            }
        };
    }

    async _captureScreenshot() {
        return new Promise((resolve, reject) => {
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
    }

    _safeLocalOCR(results) {
        return (Array.isArray(results) ? results : [])
            .filter(item => {
                const value = String(item?.text || '');
                return value && !containsSensitiveLiteral(value) &&
                    !/\b(?:password|passwd|secret|token|api[_ -]?key)\b/i.test(value);
            })
            .slice(0, 60)
            .map(item => ({
                text: String(item.text).slice(0, 160),
                bbox: item.bbox
            }));
    }

    _safeOCRFailureReason(error) {
        const message = String(error?.message || error || '').toLowerCase();
        if (message.includes('tesseract.js is not loaded') || message.includes('tesseract is not loaded')) {
            return 'tesseract-library-missing';
        }
        if (message.includes('extension runtime')) return 'extension-runtime-unavailable';
        if (/offscreen|chrome\.runtime|service worker/.test(message)) return 'offscreen-unavailable';
        if (/timeout|timed out|aborted/.test(message)) return 'timeout';
        if (/worker|wasm|traineddata|fetch|network|module|import|load|csp|securityerror|blob|404|403|cors/.test(message)) {
            return 'worker-load-failed';
        }
        return 'provider-error';
    }

    async _ensureOCRInitialized() {
        if (this._ocrInitialized) return;
        if (this._ocrInitPromise) return this._ocrInitPromise;

        this._ocrInitPromise = Promise.resolve()
            .then(() => {
                if (typeof this.ocrProvider.initialize === 'function') {
                    return this.ocrProvider.initialize();
                }
            })
            .then(() => {
                this._ocrInitialized = true;
            })
            .catch(error => {
                this._ocrInitPromise = null;
                throw error;
            });
        return this._ocrInitPromise;
    }

    _normalizeOCRResults(output, scaleX, scaleY, image) {
        const rawResults = Array.isArray(output)
            ? output
            : Array.isArray(output?.results)
                ? output.results
                : output?.data?.words || output?.data?.blocks
                    ? this._flattenOCRBlocks(output.data)
                    : null;
        if (!Array.isArray(rawResults)) {
            throw new Error('OCR provider returned an invalid result');
        }

        return rawResults
            .map(result => {
                const text = String(result?.text || '').trim();
                if (!text) return null;
                return {
                    text,
                    bbox: this._normalizeOCRBox(result.bbox, scaleX, scaleY, image),
                    confidence: Number.isFinite(result.confidence) ? result.confidence : 0,
                    source: 'OCR'
                };
            })
            .filter(Boolean);
    }

    _flattenOCRBlocks(data) {
        const words = [];
        const visit = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node.words)) words.push(...node.words);
            if (Array.isArray(node.lines)) node.lines.forEach(visit);
            if (Array.isArray(node.paragraphs)) node.paragraphs.forEach(visit);
            if (Array.isArray(node.blocks)) node.blocks.forEach(visit);
        };
        visit(data);
        return words;
    }

    _normalizeOCRBox(bbox, scaleX, scaleY, image) {
        let x;
        let y;
        let width;
        let height;
        if (Array.isArray(bbox)) {
            [x, y, width, height] = bbox;
        } else if (bbox && Number.isFinite(bbox.x0)) {
            x = bbox.x0;
            y = bbox.y0;
            width = bbox.x1 - bbox.x0;
            height = bbox.y1 - bbox.y0;
        } else if (bbox) {
            ({ x, y, width, height } = bbox);
        }

        if (![x, y, width, height].every(Number.isFinite)) {
            return {
                x: 0,
                y: 0,
                width: Math.max(1, image?.width || 1) / scaleX,
                height: Math.max(1, image?.height || 1) / scaleY
            };
        }

        const safeScaleX = scaleX > 0 ? scaleX : 1;
        const safeScaleY = scaleY > 0 ? scaleY : 1;
        return {
            x: x / safeScaleX,
            y: y / safeScaleY,
            width: Math.max(0, width) / safeScaleX,
            height: Math.max(0, height) / safeScaleY
        };
    }

    async executeValidatedAction(action) {
        const ALLOWED = new Set(['click', 'scroll', 'focus', 'select', 'wait', 'keypress', 'type_local']);
        if (!ALLOWED.has(action.type)) {
            return { success: false, error: 'Action type not allowed' };
        }

        if (action.type === 'wait') {
            const requested = Number(action.args?.ms);
            const ms = Number.isFinite(requested)
                ? Math.max(50, Math.min(5000, Math.round(requested)))
                : 500;
            await new Promise(r => setTimeout(r, ms));
            return { success: true };
        }

        if (action.type === 'type_local') {
            await this._ensureSecretsLoaded();
            // Non-secret text typing (e.g. note title) uses args.text. Some
            // providers call the same field value; accept it as a compatible
            // alias without treating it as a local secret.
            if (!action.args?.secret_ref &&
                (typeof action.args?.text === 'string' || typeof action.args?.value === 'string')) {
                const textAction = {
                    ...action,
                    args: {
                        ...(action.args || {}),
                        text: action.args?.text ?? action.args?.value
                    }
                };
                return this._executeTypeText(textAction);
            }
            return this._executeTypeLocal(action);
        }

        const selector = action.type === 'keypress' && !String(action.target || '').trim()
            ? ''
            : ActionExecutor.selectorForTarget(action.target);
        if (!selector && !['scroll', 'keypress'].includes(action.type)) {
            return { success: false, error: 'No target specified' };
        }
        const executionTarget = action.type === 'keypress' && !String(action.target || '').trim()
            ? ''
            : (selector || 'body');
        return this.executor.execute(action.type, executionTarget, action.args || {});
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

    _isPasswordTarget(element) {
        if (!element) return false;
        const type = String(element.type || '').toLowerCase();
        const autocomplete = String(element.getAttribute?.('autocomplete') || '').toLowerCase();
        const identity = [
            element.id,
            element.name,
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('placeholder'),
            element.labels?.[0]?.textContent,
            element.textContent
        ].filter(Boolean).join(' ').toLowerCase();

        return type === 'password' ||
            autocomplete === 'current-password' ||
            autocomplete === 'new-password' ||
            /(^|[-_ ])(password|passwd|pwd)([-_ ]|$)/i.test(identity) ||
            /password|passwd|pwd/i.test(identity);
    }

    _isIdentityTarget(element) {
        if (!element) return false;
        const type = String(element.type || '').toLowerCase();
        const autocomplete = String(element.getAttribute?.('autocomplete') || '').toLowerCase();
        const identity = [
            element.id,
            element.name,
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('placeholder'),
            element.getAttribute?.('title'),
            element.getAttribute?.('data-testid'),
            element.labels?.[0]?.textContent
        ].filter(Boolean).join(' ').toLowerCase();
        return ['email', 'tel', 'url'].includes(type) ||
            ['email', 'username', 'tel', 'search', 'current-password', 'new-password'].includes(autocomplete) ||
            /\b(?:e[-\s]?mail|username|user\s*name|user\s*id|account|login|log\s*in|sign\s*in|credential|phone|telephone)\b/.test(identity);
    }

    _isContentEditable(element) {
        const tag = element?.tagName?.toLowerCase();
        if (['input', 'textarea', 'select', 'button', 'a'].includes(tag)) return false;
        const raw = element?.getAttribute?.('contenteditable');
        if (raw !== null && raw !== undefined) {
            const value = String(raw).toLowerCase();
            return value === '' || value === 'true' || value === 'plaintext-only';
        }
        const ancestor = element?.closest?.('[contenteditable]');
        if (ancestor && ancestor !== element) {
            const value = String(ancestor.getAttribute('contenteditable') || '').toLowerCase();
            return value === '' || value === 'true' || value === 'plaintext-only';
        }
        return false;
    }

    _isTextInput(element, { allowPassword = false } = {}) {
        const tag = element?.tagName?.toLowerCase();
        if (tag === 'textarea' || this._isContentEditable(element)) return true;
        if (tag !== 'input') return false;
        const type = String(element.type || 'text').toLowerCase();
        if (type === 'password') return allowPassword;
        return ['text', 'search', 'email', 'url', 'tel', 'number'].includes(type);
    }

    _prepareEditable(element, secretRef = null) {
        if (!element) return { valid: false, reason: 'Element not found' };
        const allowPassword = secretRef === 'password';
        if (!this._isTextInput(element, { allowPassword })) {
            return { valid: false, reason: 'Target must be an editable text control' };
        }
        if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') {
            return { valid: false, reason: 'Target is disabled' };
        }
        if (element.readOnly || element.getAttribute?.('aria-readonly') === 'true') {
            return { valid: false, reason: 'Target is read-only' };
        }
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return { valid: false, reason: 'Target is not visible' };
        let style;
        try { style = window.getComputedStyle(element); } catch (_) { style = null; }
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
            return { valid: false, reason: 'Target is not visible' };
        }
        if (secretRef) {
            const validation = LocalSecretProvider.validateTarget(element, secretRef);
            if (!validation.valid) return validation;
        }
        try { element.focus(); } catch (_) { /* handled below */ }
        if (document.activeElement !== element) return { valid: false, reason: 'Target did not become active' };
        return { valid: true };
    }

    _readEditableText(element) {
        if (this._isContentEditable(element)) {
            // Some controlled editors expose an empty innerText while their
            // textContent is current. Prefer either non-empty representation.
            return String(element.innerText || element.textContent || '');
        }
        return String(element.value ?? '');
    }

    _verifyEditableText(element, expected) {
        const normalize = value => String(value || '')
            .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const wanted = normalize(expected);
        if (!wanted) return false;
        const candidates = [
            this._readEditableText(element),
            element?.textContent,
            element?.innerText,
            element?.value
        ];
        return candidates.some(value => normalize(value).includes(wanted));
    }

    _replaceEditableWithoutInput(element, value) {
        if (this._isContentEditable(element)) {
            element.textContent = String(value);
        } else {
            const view = element.ownerDocument?.defaultView || window;
            const isTextarea = element.tagName?.toLowerCase() === 'textarea';
            const prototype = isTextarea
                ? view.HTMLTextAreaElement?.prototype
                : view.HTMLInputElement?.prototype;
            const setter = prototype
                ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set
                : null;
            if (setter) setter.call(element, String(value));
            else element.value = String(value);
        }
        const EventCtor = element.ownerDocument?.defaultView?.Event || Event;
        element.dispatchEvent(new EventCtor('change', { bubbles: true }));
    }

    _executeTypeText(action) {
        const selector = ActionExecutor.selectorForTarget(action.target);
        if (!selector) return { success: false, error: 'No target specified' };

        let element;
        try { element = document.querySelector(selector); }
        catch (_) { return { success: false, error: 'Invalid selector' }; }
        if (!element) return { success: false, error: 'Element not found' };

        if (this._isPasswordTarget(element)) {
            return { success: false, error: 'Use secret_ref for password fields' };
        }
        if (this._isIdentityTarget(element)) {
            return { success: false, error: 'Use secret_ref for identity fields' };
        }
        const prepared = this._prepareEditable(element);
        if (!prepared.valid) return { success: false, error: prepared.reason };

        const value = String(action.args?.text ?? action.args?.value ?? '');
        if (value.length > 2000) return { success: false, error: 'Text is too long' };
        const normalize = text => String(text || '')
            .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const actual = normalize(this._readEditableText(element));
        const wanted = normalize(value);
        const fingerprint = textFingerprint(value);
        const recent = this._recentTypeWrites.get(element);
        // A second message can arrive while a controlled editor is still
        // committing its first input event. Do not dispatch it again during
        // that short single-flight window.
        if (recent && recent.fingerprint === fingerprint &&
            Date.now() - recent.at < 1500 &&
            (!actual || actual === wanted)) {
            return { success: true, verified: true, idempotent: true };
        }
        // Type actions are replace operations. Treat an already-applied
        // value as an idempotent success, and repair the specific duplicate
        // shape produced when a page handles two rapid input events.
        if (wanted && actual === wanted) {
            this._recentTypeWrites.set(element, { fingerprint, at: Date.now() });
            return { success: true, verified: true, idempotent: true };
        }
        const repeated = Boolean(wanted) && (
            actual === wanted + wanted ||
            actual === `${wanted} ${wanted}`
        );
        LocalSecretProvider.insertSecret(element, value, {
            blur: false,
            // Ordinary message/task text uses one input event. A synthetic
            // beforeinput followed by input can be interpreted as two inserts
            // by controlled editors.
            beforeinput: false
        });
        const afterInsert = normalize(this._readEditableText(element));
        const duplicatedAfterInsert = Boolean(wanted) && (
            afterInsert === wanted + wanted ||
            afterInsert === `${wanted} ${wanted}`
        );
        if (duplicatedAfterInsert) {
            // A page may synchronously append during its input handler. Repair
            // the visible value without dispatching a second input event,
            // which would append again.
            this._replaceEditableWithoutInput(element, value);
        }
        this._recentTypeWrites.set(element, { fingerprint, at: Date.now() });
        if (!this._verifyEditableText(element, value)) {
            // A controlled contenteditable can accept the DOM/input event
            // while exposing no readable value in the same task. Preserve the
            // successful local write and let the postcondition verifier judge
            // the resulting composer/conversation state.
            if (this._isContentEditable(element)) {
                return { success: true, verified: true, inferred: true };
            }
            this._recentTypeWrites.delete(element);
            return { success: false, error: 'Text could not be verified', verified: false };
        }
        return { success: true, verified: true, idempotent: repeated };
    }

    _executeTypeLocal(action) {
        const secretRef = this._normalizeSecretRef(action.args?.secret_ref);
        if (!secretRef) return { success: false, error: 'Missing local secret reference' };
        if (!this.secretProvider.has(secretRef)) {
            return { success: false, error: 'Local email/password is not configured in the extension popup' };
        }

        const selector = ActionExecutor.selectorForTarget(action.target);
        if (!selector) return { success: false, error: 'No target specified' };
        let element;
        try { element = document.querySelector(selector); }
        catch (_) { return { success: false, error: 'Invalid selector' }; }

        const prepared = this._prepareEditable(element, secretRef);
        if (!prepared.valid) return { success: false, error: prepared.reason };

        // Resolve and insert — secret value stays in this function scope only.
        const value = this.secretProvider.get(secretRef);
        if (!value) return { success: false, error: 'Secret not available' };
        LocalSecretProvider.insertSecret(element, value, { blur: false });
        // Do not return or log the value.  A secret is considered verified by
        // the local provider's type-compatible insertion path.
        return { success: true, verified: true };
    }

    async _preprocessImage(dataUri) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                fn(value);
            };
            const timeout = setTimeout(() => {
                finish(reject, new Error('Screenshot preprocessing timed out'));
            }, 15000);

            img.onload = () => {
                try {
                    const MAX_WIDTH = 1920;
                    let w = img.width, h = img.height;
                    if (w <= 0 || h <= 0) throw new Error('Screenshot has no dimensions');
                    if (w > MAX_WIDTH) { h = Math.floor(h * MAX_WIDTH / w); w = MAX_WIDTH; }
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    clearTimeout(timeout);
                    finish(resolve, canvas);
                } catch (e) {
                    clearTimeout(timeout);
                    finish(reject, e);
                }
            };
            img.onerror = () => {
                clearTimeout(timeout);
                finish(reject, new Error('Screenshot could not be decoded'));
            };
            img.src = dataUri;
        });
    }
}
