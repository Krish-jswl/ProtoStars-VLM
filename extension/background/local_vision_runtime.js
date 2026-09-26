const OFFSCREEN_PATH = 'local_agent/local_vision.html';
let createPromise = null;
let offscreenReady = false;

function apiAvailable() {
    return typeof chrome !== 'undefined' &&
        chrome.offscreen &&
        typeof chrome.offscreen.createDocument === 'function' &&
        chrome.runtime &&
        typeof chrome.runtime.sendMessage === 'function';
}

function requestId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (_) { /* fallback below */ }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function abortError() {
    const error = new Error('LOCAL_VISION_CANCELLED');
    error.name = 'AbortError';
    return error;
}

export class LocalVisionRuntime {
    constructor({ timeoutMs = 120000 } = {}) {
        this.timeoutMs = Math.max(1000, Number(timeoutMs) || 120000);
    }

    async _ensureOffscreen() {
        if (!apiAvailable()) throw new Error('LOCAL_VISION_UNAVAILABLE');
        if (offscreenReady) return;
        const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
        if (typeof chrome.runtime.getContexts === 'function') {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT'],
                documentUrls: [documentUrl]
            });
            if (Array.isArray(contexts) && contexts.length > 0) {
                offscreenReady = true;
                return;
            }
        }
        if (createPromise) return createPromise;
        createPromise = new Promise((resolve, reject) => {
            try {
                chrome.offscreen.createDocument({
                    url: OFFSCREEN_PATH,
                    reasons: ['WORKERS'],
                    justification: 'Run the packaged local vision model away from the webpage and MV3 service worker.'
                }, () => {
                    const error = chrome.runtime.lastError;
                    if (!error) {
                        offscreenReady = true;
                        resolve();
                        return;
                    }
                    // A service-worker restart can leave the document alive
                    // while getContexts is unavailable. That race is safe to
                    // treat as success; all other creation errors are real.
                    if (/single offscreen|already exists|only a single/i.test(error.message || '')) {
                        offscreenReady = true;
                        resolve();
                    } else {
                        reject(new Error('LOCAL_VISION_UNAVAILABLE'));
                    }
                });
            } catch (_) {
                reject(new Error('LOCAL_VISION_UNAVAILABLE'));
            }
        }).finally(() => {
            createPromise = null;
        });
        return createPromise;
    }

    _send(message, { signal, timeoutMs = this.timeoutMs } = {}) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            let abortHandler = null;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
                fn(value);
            };
            timer = setTimeout(() => {
                finish(reject, new Error(message?.type === 'LOCAL_OCR_RECOGNIZE'
                    ? 'LOCAL_OCR_TIMEOUT'
                    : 'LOCAL_VISION_TIMEOUT'));
            }, Math.max(1000, Number(timeoutMs) || this.timeoutMs));
            if (signal) {
                abortHandler = () => finish(reject, abortError());
                if (signal.aborted) {
                    abortHandler();
                    return;
                }
                signal.addEventListener('abort', abortHandler, { once: true });
            }
            try {
                chrome.runtime.sendMessage({ target: 'local-vision-offscreen', ...message }, (response) => {
                    const error = chrome.runtime.lastError;
                    if (error) {
                        offscreenReady = false;
                        finish(reject, new Error('LOCAL_VISION_UNAVAILABLE'));
                    } else {
                        finish(resolve, response || {
                        ok: false,
                        unavailable: true,
                        reason: message?.type === 'LOCAL_OCR_RECOGNIZE'
                            ? 'OCR_OFFSCREEN_UNAVAILABLE'
                            : 'LOCAL_VISION_UNAVAILABLE'
                    });
                    }
                });
            } catch (_) {
                finish(reject, new Error('LOCAL_VISION_UNAVAILABLE'));
            }
        });
    }

    async infer(input, { signal } = {}) {
        if (!apiAvailable()) return { ok: false, unavailable: true, reason: 'LOCAL_VISION_UNAVAILABLE' };
        try {
            await this._ensureOffscreen();
        } catch (_) {
            return { ok: false, unavailable: true, reason: 'LOCAL_VISION_UNAVAILABLE' };
        }
        const id = requestId();
        try {
            const response = await this._send({
                type: 'LOCAL_VISION_INFER',
                requestId: id,
                timeoutMs: this.timeoutMs,
                goal: input.goal,
                dom: input.dom,
                image: input.image,
                ocr: input.ocr
            }, { signal });
            if (!response || response.requestId && response.requestId !== id) {
                return { ok: false, unavailable: true, reason: 'LOCAL_VISION_UNAVAILABLE' };
            }
            return response;
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            return {
                ok: false,
                unavailable: true,
                reason: error?.message === 'LOCAL_VISION_TIMEOUT' ? 'LOCAL_VISION_TIMEOUT' : 'LOCAL_VISION_UNAVAILABLE'
            };
        }
    }

    async recognizeOcr(image, { timeoutMs = 45000 } = {}) {
        const dataUri = typeof image === 'string' ? image : '';
        if (!/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(dataUri)) {
            return { ok: false, reason: 'OCR_IMAGE_INVALID' };
        }
        if (dataUri.length > 16 * 1024 * 1024) {
            return { ok: false, reason: 'OCR_IMAGE_TOO_LARGE' };
        }
        if (!apiAvailable()) return { ok: false, reason: 'OCR_OFFSCREEN_UNAVAILABLE' };
        try {
            await this._ensureOffscreen();
        } catch (_) {
            return { ok: false, reason: 'OCR_OFFSCREEN_UNAVAILABLE' };
        }
        try {
            return await this._send({
                type: 'LOCAL_OCR_RECOGNIZE',
                image: dataUri,
                timeoutMs: Math.max(1000, Number(timeoutMs) || 45000)
            }, { timeoutMs });
        } catch (error) {
            return {
                ok: false,
                reason: error?.message === 'LOCAL_OCR_TIMEOUT'
                    ? 'OCR_TIMEOUT'
                    : 'OCR_OFFSCREEN_UNAVAILABLE'
            };
        }
    }

    async status() {
        if (!apiAvailable()) return { ok: false, metrics: { status: 'unavailable', backend: 'unknown' } };
        try {
            await this._ensureOffscreen();
            return await this._send({ type: 'LOCAL_VISION_STATUS' });
        } catch (_) {
            return { ok: false, metrics: { status: 'unavailable', backend: 'unknown' } };
        }
    }

    async dispose() {
        if (!apiAvailable()) return { ok: true };
        try {
            await this._ensureOffscreen();
            return await this._send({ type: 'LOCAL_VISION_DISPOSE' });
        } catch (_) {
            return { ok: true };
        }
    }
}
