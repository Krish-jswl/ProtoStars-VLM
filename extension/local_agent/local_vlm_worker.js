import {
    AutoModelForVision2Seq,
    AutoProcessor,
    InterruptableStoppingCriteria,
    env,
    load_image
} from '@huggingface/transformers';
import {
    LOCAL_VISION_DTYPE,
    LOCAL_VISION_MAX_NEW_TOKENS,
    LOCAL_VISION_MODEL_ID,
    LOCAL_VISION_MODEL_REVISION,
    buildLocalVisionPrompt,
    parseLocalVisionOutput
} from './local_vision_protocol.js';
import { detectLocalVlmBackend } from './local_vlm_runtime.js';

const LOCAL_ASSET_ROOT = new URL('./', self.location.href);
const MODEL_ROOT = new URL('./models/', LOCAL_ASSET_ROOT);
const ORT_ROOT = new URL('./runtime/ort/', LOCAL_ASSET_ROOT);
const originalFetch = self.fetch.bind(self);

let session = null;
let initPromise = null;
let activeRequest = null;
let disposed = false;
let forcedBackend = null;
let metrics = {
    backend: 'unknown',
    status: 'idle',
    coldInitMs: null,
    warmInferenceMs: null,
    preprocessMs: null,
    totalMs: null,
    inferenceCount: 0,
    memoryBytes: null
};

function post(message) {
    self.postMessage(message);
}

function now() {
    return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

function localOnlyUrl(value) {
    try {
        const url = new URL(String(value), self.location.href);
        if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
        return url.protocol === 'chrome-extension:' &&
            url.origin === self.location.origin &&
            url.pathname.startsWith(LOCAL_ASSET_ROOT.pathname);
    } catch (_) {
        return false;
    }
}

function guardedFetch(input, init) {
    const candidate = typeof input === 'string' ? input : input?.url;
    if (!localOnlyUrl(candidate)) {
        return Promise.reject(new Error('REMOTE_FETCH_BLOCKED'));
    }
    return originalFetch(input, init);
}

function configureEnvironment(backend) {
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    env.useWasmCache = false;
    env.localModelPath = MODEL_ROOT.href;
    env.fetch = guardedFetch;
    self.fetch = guardedFetch;

    const onnx = env.backends?.onnx;
    if (onnx?.wasm) {
        onnx.wasm.numThreads = 1;
        onnx.wasm.proxy = false;
        onnx.wasm.wasmPaths = backend === 'webgpu'
            ? {
                mjs: new URL('ort-wasm-simd-threaded.jsep.mjs', ORT_ROOT).href,
                wasm: new URL('ort-wasm-simd-threaded.jsep.wasm', ORT_ROOT).href
            }
            : {
                mjs: new URL('ort-wasm-simd-threaded.mjs', ORT_ROOT).href,
                wasm: new URL('ort-wasm-simd-threaded.wasm', ORT_ROOT).href
            };
        onnx.logLevel = 'error';
    }
}

async function chooseBackend() {
    return detectLocalVlmBackend(navigator);
}

async function disposeModel(candidate) {
    const current = candidate || session;
    if (!current) return;
    try {
        await current.model?.dispose?.();
    } catch (_) {
        // Disposal is best effort; no model text or error is logged.
    }
}

async function loadForBackend(backend, progressCallback) {
    configureEnvironment(backend);
    const options = {
        revision: LOCAL_VISION_MODEL_REVISION,
        local_files_only: true,
        progress_callback: progressCallback
    };
    const started = now();
    const processor = await AutoProcessor.from_pretrained(LOCAL_VISION_MODEL_ID, options);
    const model = await AutoModelForVision2Seq.from_pretrained(LOCAL_VISION_MODEL_ID, {
        ...options,
        dtype: LOCAL_VISION_DTYPE,
        device: backend
    });
    return {
        backend,
        processor,
        model,
        coldInitMs: now() - started
    };
}

async function ensureSession() {
    if (session && !disposed) return session;
    if (initPromise) return initPromise;
    disposed = false;
    initPromise = (async () => {
        const selected = forcedBackend
            ? { backend: forcedBackend, reason: 'forced-fallback' }
            : await chooseBackend();
        metrics.backend = selected.backend;
        metrics.status = 'loading';
        post({ type: 'status', status: 'loading', backend: selected.backend, reason: selected.reason });
        let loaded;
        try {
            loaded = await loadForBackend(selected.backend, (progress) => {
                // Only lifecycle/file metadata is forwarded. No prompt or image
                // contents are ever posted.
                post({
                    type: 'progress',
                    status: progress?.status || 'loading',
                    file: typeof progress?.file === 'string' ? progress.file.slice(0, 160) : ''
                });
            });
        } catch (error) {
            // A WebGPU device can exist while the selected quantized kernels
            // still fail. Retry once with the local WASM session.
            if (selected.backend === 'webgpu') {
                try {
                    forcedBackend = 'wasm';
                    metrics.backend = 'wasm';
                    post({ type: 'status', status: 'loading', backend: 'wasm', reason: 'webgpu-fallback' });
                    loaded = await loadForBackend('wasm');
                } catch (_) {
                    metrics.status = 'unavailable';
                    initPromise = null;
                    throw new Error('LOCAL_VISION_UNAVAILABLE');
                }
            } else {
                metrics.status = 'unavailable';
                initPromise = null;
                throw new Error('LOCAL_VISION_UNAVAILABLE');
            }
        }
        session = loaded;
        metrics.coldInitMs = loaded.coldInitMs;
        metrics.status = 'ready';
        post({
            type: 'status',
            status: 'ready',
            backend: loaded.backend,
            coldInitMs: metrics.coldInitMs,
            inferenceCount: metrics.inferenceCount
        });
        return session;
    })();
    try {
        return await initPromise;
    } finally {
        initPromise = null;
    }
}

async function preprocessImage(imageData) {
    if (typeof imageData !== 'string' || imageData.length > 8_000_000) {
        throw new Error('LOCAL_VISION_IMAGE_INVALID');
    }
    const image = await load_image(imageData);
    // Keep activation memory bounded on small browsers. The processor performs
    // its own patch preprocessing after this resize.
    if (image.width > 1024) {
        return image.resize(1024, -1);
    }
    return image;
}

function memorySnapshot() {
    try {
        const bytes = performance?.memory?.usedJSHeapSize;
        return Number.isFinite(bytes) ? bytes : null;
    } catch (_) {
        return null;
    }
}

async function runLoadedInference(loaded, request, started, stoppingCriteria) {
    const preprocessStarted = now();
    const image = await preprocessImage(request.image);
    const prompt = buildLocalVisionPrompt({
        goal: request.goal,
        domElements: request.dom,
        ocrResults: request.ocr
    });
    const messages = [{
        role: 'user',
        content: [
            { type: 'image', image },
            { type: 'text', text: prompt }
        ]
    }];
    const text = loaded.processor.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await loaded.processor(text, [image], { do_image_splitting: false });
    metrics.preprocessMs = now() - preprocessStarted;

    const inferenceStarted = now();
    const generated = await loaded.model.generate({
        ...inputs,
        max_new_tokens: LOCAL_VISION_MAX_NEW_TOKENS,
        do_sample: false,
        repetition_penalty: 1.05,
        stopping_criteria: stoppingCriteria,
        return_dict_in_generate: true
    });
    metrics.warmInferenceMs = now() - inferenceStarted;
    metrics.inferenceCount += 1;
    const sequences = generated?.sequences ?? generated;
    const decoded = loaded.processor.batch_decode(sequences, { skip_special_tokens: true });
    const rawOutput = Array.isArray(decoded) ? decoded[0] : decoded;
    const parsed = parseLocalVisionOutput(rawOutput, request.goal, request.dom, request.ocr);
    metrics.totalMs = now() - started;
    metrics.memoryBytes = memorySnapshot();
    if (!parsed.ok) {
        return {
            type: 'result',
            requestId: request.requestId,
            ok: false,
            abstained: !!parsed.abstained,
            reason: parsed.reason || 'invalid-model-plan',
            metrics: { ...metrics }
        };
    }
    return {
        type: 'result',
        requestId: request.requestId,
        ok: true,
        actions: parsed.actions,
        grounding: parsed.grounding,
        metrics: { ...metrics }
    };
}

async function infer(request) {
    const started = now();
    const stoppingCriteria = new InterruptableStoppingCriteria();
    activeRequest = { id: request.requestId, stoppingCriteria };
    try {
        const loaded = await ensureSession();
        try {
            return await runLoadedInference(loaded, request, started, stoppingCriteria);
        } catch (error) {
            if (loaded.backend !== 'webgpu') throw error;
            // A WebGPU adapter can pass feature detection but fail during
            // shader/session creation. Retry this request once with WASM.
            await disposeModel(loaded);
            session = null;
            forcedBackend = 'wasm';
            metrics.backend = 'wasm';
            return infer(request);
        }
    } finally {
        if (activeRequest?.id === request.requestId) activeRequest = null;
    }
}

function errorCategory(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '').toLowerCase();
    if (name === 'AbortError' || message.includes('interrupt')) return 'cancelled';
    if (message.includes('local_vision_unavailable') || message.includes('fetch') || message.includes('model')) return 'unavailable';
    return 'failed';
}

self.addEventListener('message', async (event) => {
    const request = event.data || {};
    if (request.type === 'status') {
        post({ type: 'status', status: metrics.status, metrics: { ...metrics } });
        return;
    }
    if (request.type === 'cancel') {
        if (activeRequest && (!request.requestId || activeRequest.id === request.requestId)) {
            activeRequest.stoppingCriteria.interrupt();
        }
        return;
    }
    if (request.type === 'dispose') {
        await disposeModel();
        session = null;
        disposed = true;
        forcedBackend = null;
        metrics.status = 'disposed';
        post({ type: 'disposed', metrics: { ...metrics } });
        return;
    }
    if (request.type !== 'infer') return;
    if (activeRequest) {
        post({ type: 'result', requestId: request.requestId, ok: false, reason: 'busy' });
        return;
    }
    try {
        const result = await infer(request);
        post(result);
    } catch (error) {
        const category = errorCategory(error);
        post({
            type: 'result',
            requestId: request.requestId,
            ok: false,
            unavailable: category === 'unavailable',
            reason: category === 'unavailable' ? 'LOCAL_VISION_UNAVAILABLE' : category,
            metrics: { ...metrics }
        });
    }
});

post({ type: 'status', status: 'created', backend: 'unknown' });
