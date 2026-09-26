/* global chrome, Worker */

const WORKER_URL = chrome.runtime.getURL('local_agent/local_vlm_worker.bundle.js');
let worker = null;
let workerGeneration = 0;
let status = {
    status: 'created',
    backend: 'unknown',
    coldInitMs: null,
    warmInferenceMs: null,
    preprocessMs: null,
    totalMs: null,
    inferenceCount: 0,
    memoryBytes: null
};
const pending = new Map();
const OCR_TIMEOUT_MS = 45000;
let ocrWorker = null;
let ocrWorkerPromise = null;

function safeMetrics(value) {
    if (!value || typeof value !== 'object') return status;
    const number = key => Number.isFinite(Number(value[key])) ? Math.max(0, Number(value[key])) : null;
    return {
        status: typeof value.status === 'string' ? value.status.slice(0, 64) : status.status,
        backend: ['webgpu', 'wasm', 'unknown'].includes(value.backend) ? value.backend : 'unknown',
        coldInitMs: number('coldInitMs'),
        warmInferenceMs: number('warmInferenceMs'),
        preprocessMs: number('preprocessMs'),
        totalMs: number('totalMs'),
        inferenceCount: number('inferenceCount'),
        memoryBytes: number('memoryBytes')
    };
}

function settle(requestId, result) {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
}

function rejectPending(reason = 'LOCAL_VISION_UNAVAILABLE') {
    for (const requestId of [...pending.keys()]) {
        settle(requestId, { ok: false, unavailable: reason === 'LOCAL_VISION_UNAVAILABLE', reason });
    }
}

function createWorker() {
    if (worker) return worker;
    const instance = new Worker(WORKER_URL);
    const generation = ++workerGeneration;
    instance.addEventListener('message', (event) => {
        if (generation !== workerGeneration) return;
        const message = event.data || {};
        if (message.type === 'status' || message.type === 'progress') {
            status = safeMetrics({ ...status, ...message });
            return;
        }
        if (message.type === 'disposed') {
            status = safeMetrics({ ...status, ...message, status: 'disposed' });
            return;
        }
        if (message.type === 'result') {
            if (message.metrics) status = safeMetrics({ ...status, ...message.metrics });
            settle(message.requestId, message);
        }
    });
    instance.addEventListener('error', () => {
        if (generation !== workerGeneration) return;
        try { instance.terminate(); } catch (_) { /* best effort */ }
        if (worker === instance) worker = null;
        workerGeneration++;
        status = { ...status, status: 'unavailable', backend: 'unknown' };
        rejectPending();
    });
    worker = instance;
    return instance;
}

function infer(request) {
    const instance = createWorker();
    const requestId = String(request.requestId || '');
    if (!requestId) return Promise.resolve({ ok: false, unavailable: true, reason: 'LOCAL_VISION_UNAVAILABLE' });
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            try { instance.postMessage({ type: 'cancel', requestId }); } catch (_) { /* best effort */ }
            settle(requestId, { ok: false, unavailable: true, reason: 'LOCAL_VISION_TIMEOUT' });
        }, Number(request.timeoutMs) || 120000);
        pending.set(requestId, { resolve, timer });
        try {
            instance.postMessage({
                type: 'infer',
                requestId,
                goal: String(request.goal || ''),
                dom: Array.isArray(request.dom) ? request.dom : [],
                image: typeof request.image === 'string' ? request.image : '',
                ocr: Array.isArray(request.ocr) ? request.ocr : []
            });
        } catch (_) {
            settle(requestId, { ok: false, unavailable: true, reason: 'LOCAL_VISION_UNAVAILABLE' });
        }
    });
}

function dispose() {
    if (!worker) {
        status = { ...status, status: 'disposed' };
        return Promise.resolve({ ok: true });
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: true }), 5000);
        const onMessage = (event) => {
            if (event.data?.type !== 'disposed') return;
            clearTimeout(timer);
            worker?.removeEventListener('message', onMessage);
            resolve({ ok: true });
        };
        worker.addEventListener('message', onMessage);
        try { worker.postMessage({ type: 'dispose' }); } catch (_) {
            clearTimeout(timer);
            resolve({ ok: true });
        }
    });
}

function ocrResultWords(data, image = {}) {
    const words = [];
    const addWord = word => {
        if (!word || typeof word.text !== 'string' || !word.text.trim()) return;
        const box = word.bbox;
        if (!box) return;
        words.push({
            text: word.text.slice(0, 300),
            bbox: Array.isArray(box)
                ? box.map(value => Number(value) || 0)
                : [Number(box.x0) || 0, Number(box.y0) || 0,
                    (Number(box.x1) || 0) - (Number(box.x0) || 0),
                    (Number(box.y1) || 0) - (Number(box.y0) || 0)],
            confidence: Number.isFinite(Number(word.confidence)) ? Number(word.confidence) : 0,
            source: 'OCR'
        });
    };
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node.words)) node.words.forEach(addWord);
        if (Array.isArray(node.lines)) node.lines.forEach(visit);
        if (Array.isArray(node.paragraphs)) node.paragraphs.forEach(visit);
        if (Array.isArray(node.blocks)) node.blocks.forEach(visit);
    };
    if (Array.isArray(data?.words)) data.words.forEach(addWord);
    visit(data?.blocks);
    if (words.length) return words.slice(0, 500);
    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    if (!text) return [];
    return [{
        text: text.slice(0, 2000),
        bbox: [0, 0, Number(image.width) || 1, Number(image.height) || 1],
        confidence: 0,
        source: 'OCR'
    }];
}

async function createOcrWorker() {
    if (ocrWorker) return ocrWorker;
    if (ocrWorkerPromise) return ocrWorkerPromise;
    const tesseract = globalThis.Tesseract;
    if (!tesseract || typeof tesseract.createWorker !== 'function') {
        throw new Error('OCR_LIBRARY_UNAVAILABLE');
    }
    ocrWorkerPromise = tesseract.createWorker('eng', 1, {
        workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
        corePath: chrome.runtime.getURL('lib/tesseract/tesseract-core.wasm.js'),
        langPath: chrome.runtime.getURL('lib/tesseract/'),
        // The offscreen document has the extension origin, so a direct worker
        // is safe even when the page has a strict worker-src CSP.
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true
    }).then(instance => {
        ocrWorker = instance;
        return instance;
    }).finally(() => {
        ocrWorkerPromise = null;
    });
    return ocrWorkerPromise;
}

async function recognizeOcr(request) {
    const image = typeof request?.image === 'string' ? request.image : '';
    if (!/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(image)) {
        return { ok: false, reason: 'OCR_IMAGE_INVALID' };
    }
    try {
        const instance = await createOcrWorker();
        const response = await Promise.race([
            instance.recognize(image, {}, { text: true, blocks: true }),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('OCR_TIMEOUT')),
                Math.max(1000, Number(request?.timeoutMs) || OCR_TIMEOUT_MS)
            ))
        ]);
        const data = response?.data || response || {};
        return {
            ok: true,
            results: ocrResultWords(data, {
                width: Number(request?.imageWidth) || 0,
                height: Number(request?.imageHeight) || 0
            })
        };
    } catch (_) {
        try { await ocrWorker?.terminate(); } catch (_) { /* best effort */ }
        ocrWorker = null;
        return { ok: false, reason: 'OCR_OFFSCREEN_UNAVAILABLE' };
    }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!request || request.target !== 'local-vision-offscreen') return false;
    if (request.type === 'LOCAL_OCR_RECOGNIZE') {
        recognizeOcr(request).then(sendResponse);
        return true;
    }
    if (request.type === 'LOCAL_VISION_INFER') {
        infer(request).then(sendResponse);
        return true;
    }
    if (request.type === 'LOCAL_VISION_STATUS') {
        sendResponse({ ok: true, metrics: status });
        return false;
    }
    if (request.type === 'LOCAL_VISION_CANCEL') {
        try { worker?.postMessage({ type: 'cancel', requestId: request.requestId }); } catch (_) { /* best effort */ }
        sendResponse({ ok: true });
        return false;
    }
    if (request.type === 'LOCAL_VISION_DISPOSE') {
        dispose().then(sendResponse);
        return true;
    }
    return false;
});
