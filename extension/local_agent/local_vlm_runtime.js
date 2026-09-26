/**
 * Runtime capability and asset-boundary helpers for the packaged local VLM.
 * The actual Transformers.js session lives in local_vlm_worker.js; keeping
 * capability detection pure makes fallback behavior testable without a
 * browser or model weights.
 */

export const LOCAL_VLM_BACKENDS = Object.freeze(['webgpu', 'wasm']);

export const LOCAL_VLM_RUNTIME_DEFAULTS = Object.freeze({
    modelDtype: 'q4f16',
    maxNewTokens: 96,
    maxImageWidth: 1024,
    wasmThreads: 1,
    requireWebGPUFeature: 'shader-f16'
});

export async function detectLocalVlmBackend(navigatorObject = globalThis.navigator) {
    if (!navigatorObject?.gpu || typeof navigatorObject.gpu.requestAdapter !== 'function') {
        return { backend: 'wasm', reason: 'webgpu-unavailable' };
    }
    try {
        const adapter = await navigatorObject.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) return { backend: 'wasm', reason: 'webgpu-adapter-unavailable' };
        const features = adapter.features;
        if (!features || typeof features.has !== 'function' ||
            !features.has(LOCAL_VLM_RUNTIME_DEFAULTS.requireWebGPUFeature)) {
            return { backend: 'wasm', reason: 'webgpu-f16-unavailable' };
        }
        return { backend: 'webgpu', reason: 'webgpu-ready' };
    } catch (_) {
        return { backend: 'wasm', reason: 'webgpu-probe-failed' };
    }
}

export function isPackagedRuntimeUrl(value, baseUrl) {
    try {
        const url = new URL(String(value), baseUrl);
        const base = new URL(baseUrl);
        return url.protocol === 'chrome-extension:' &&
            url.origin === base.origin &&
            url.pathname.startsWith(base.pathname);
    } catch (_) {
        return false;
    }
}
