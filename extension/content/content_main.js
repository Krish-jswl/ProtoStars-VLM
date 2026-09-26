
import { DOMAnalyzer } from './dom_analyzer.js';
import { ActionExecutor } from './action_executor.js';
import { PrivacyPipelineRunner } from './privacy_pipeline_runner.js';
import { Logger } from '../shared/logger.js';
import { Config } from '../shared/config.js';

const logger = new Logger('ContentScript');
const analyzer = new DOMAnalyzer();
const executor = new ActionExecutor(Config);
const pipeline = new PrivacyPipelineRunner();

function safePreviewDetection(detection) {
    const bbox = detection?.bbox || {};
    return {
        type: String(detection?.type || 'UNKNOWN').slice(0, 40),
        token: String(detection?.token || '').slice(0, 80),
        confidence: Number.isFinite(Number(detection?.confidence)) ? Number(detection.confidence) : 0,
        bbox: {
            x: Number(bbox.x) || 0,
            y: Number(bbox.y) || 0,
            width: Number(bbox.width) || 0,
            height: Number(bbox.height) || 0
        }
    };
}

// The popup can inject the bundle into an already-open tab after an extension
// reload. Remove a previous handler set before registering the new one so an
// EXECUTE_VALIDATED_ACTION message cannot be applied twice.
const CONTENT_HANDLER_KEY = '__PVA_CONTENT_HANDLERS_V3__';
const previousHandlers = globalThis[CONTENT_HANDLER_KEY];
if (previousHandlers?.runtimeListener) {
    try { chrome.runtime.onMessage.removeListener(previousHandlers.runtimeListener); } catch (_) { /* stale extension context */ }
}
if (previousHandlers?.windowListener) {
    try { window.removeEventListener('message', previousHandlers.windowListener); } catch (_) { /* stale page context */ }
}

const runtimeListener = (request, sender, sendResponse) => {
    if (request.type === 'ANALYZE_DOM') {
        logger.info('Analyzing DOM');
        const elements = analyzer.analyzeDOM();
        sendResponse({
            elements,
            // Local-only route fingerprint; query strings and page text are
            // intentionally excluded from this action-layer signal.
            route: `${window.location.origin}${window.location.pathname}`
        });
        return false;
    }

    if (request.type === 'OCR_RUNTIME_STATUS') {
        sendResponse({
            available: typeof globalThis.Tesseract?.createWorker === 'function'
        });
        return false;
    }

    if (request.type === 'EXECUTE_ACTION') {
        logger.info('Executing action', { type: request.actionType });
        // The legacy message is retained for compatibility, but it follows the
        // same ID-only target contract as the validated action path.
        const selector = ActionExecutor.selectorForTarget(request.target);
        sendResponse(executor.execute(request.actionType, selector, request.args));
        return false;
    }

    if (request.type === 'SET_SECRETS') {
        pipeline.setSecrets(request.secrets || {}, request.persist !== false);
        sendResponse({ ok: true });
        return false;
    }

    if (request.type === 'LOCAL_VISION_OBSERVE') {
        pipeline.observeForLocalVision().then(sendResponse).catch(() => {
            // Do not expose capture/provider exception text to the model or UI.
            sendResponse({ error: 'LOCAL_VISION_CAPTURE_UNAVAILABLE' });
        });
        return true;
    }

    if (request.type === 'PRIVACY_PIPELINE') {
        pipeline.run().then(sendResponse).catch((e) => {
            logger.error('Pipeline failed: ' + e.message);
            sendResponse({ allowed: false, violations: [e.message] });
        });
        return true;
    }

    if (request.type === 'PRIVACY_PREVIEW') {
        pipeline.run().then((result) => {
            sendResponse({
                allowed: !!result?.allowed,
                violations: Array.isArray(result?.violations) ? result.violations.slice(0, 10) : [],
                detections: Array.isArray(result?.redactionPlan)
                    ? result.redactionPlan.slice(0, 200).map(safePreviewDetection)
                    : [],
                screenshot: typeof result?.sanitizedContext?.image === 'string'
                    ? result.sanitizedContext.image
                    : null,
                timing: result?.timing || {}
            });
        }).catch(() => {
            sendResponse({
                allowed: false,
                violations: ['Privacy preview unavailable'],
                detections: [],
                screenshot: null,
                timing: {}
            });
        });
        return true;
    }

    if (request.type === 'EXECUTE_VALIDATED_ACTION') {
        pipeline.executeValidatedAction(request.action).then(sendResponse).catch((e) => {
            sendResponse({ success: false, error: e.message });
        });
        return true;
    }

    return false;
};

const windowListener = (event) => {
    if (event.source !== window || !event.data) return;
    const localTestPage = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    if (!localTestPage) return;
    // Test triggers are intentionally limited to local test pages. An arbitrary
    // website must not be able to start the agent or inject local secret values.
    if (event.data.type === 'AGENT_TEST_TRIGGER') {
        const message = event.data.goal
            ? { type: 'START_GOAL_AGENT', goal: String(event.data.goal).slice(0, 500) }
            : { type: 'START_AGENT' };
        chrome.runtime.sendMessage(message);
    }
    if (event.data.type === 'AGENT_SET_SECRETS' && event.data.secrets) {
        pipeline.setSecrets(event.data.secrets, false);
    }
};

globalThis[CONTENT_HANDLER_KEY] = { runtimeListener, windowListener };
chrome.runtime.onMessage.addListener(runtimeListener);
window.addEventListener('message', windowListener);
