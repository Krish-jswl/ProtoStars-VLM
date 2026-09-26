
import { AgentLoop } from './agent_loop.js';
import { LocalVisionRuntime } from './local_vision_runtime.js';

const offscreenRuntime = new LocalVisionRuntime(120000);
const loops = new Map();
const MESSAGE_GUARD_TTL_MS = 5 * 60 * 1000;
const messageGuards = new Map();

function messageTextKeyFromGoal(goal) {
    const value = String(goal || '');
    if (!/\b(?:send|write|type)\b.*\b(?:message|chat|conversation|text\s*box|textbox)\b/i.test(value)) return null;
    const quoted = value.match(/"([^"]+)"|'([^']+)'/);
    const text = quoted ? (quoted[1] ?? quoted[2]).trim() : '';
    return text ? messageTextKey(text) : null;
}

function messageTextKey(text) {
    const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    let hash = 2166136261;
    for (let index = 0; index < normalized.length; index++) {
        hash ^= normalized.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function messageGuardKey(tabId, textKey) {
    return `${tabId}:${textKey}`;
}

function getMessageGuard(tabId, textKey) {
    if (!textKey) return null;
    const key = messageGuardKey(tabId, textKey);
    const entry = messageGuards.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > MESSAGE_GUARD_TTL_MS) {
        messageGuards.delete(key);
        return null;
    }
    return entry;
}

function setMessageGuard(tabId, text, status, method = '') {
    const textKey = messageTextKey(text);
    if (!textKey) return;
    messageGuards.set(messageGuardKey(tabId, textKey), {
        at: Date.now(),
        status,
        method
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.type === 'PING') {
        sendResponse({ status: 'PONG' });
        return false;
    }

    if (request.type === 'LOG') {
        console.log('[LOG]', request.payload);
        sendResponse({ status: 'LOG_RECEIVED' });
        return false;
    }

    if (request.type === 'CAPTURE_TAB') {
        // captureVisibleTab always captures the active tab in a window.  When
        // the request came from a content script, verify that its tab is still
        // active so DOM coordinates cannot be combined with another tab's
        // screenshot.
        const capture = (windowId) => {
            chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 }, (dataUri) => {
                if (chrome.runtime.lastError) {
                    sendResponse({ error: chrome.runtime.lastError.message });
                } else if (!dataUri) {
                    sendResponse({ error: 'No screenshot returned' });
                } else {
                    sendResponse({ dataUri });
                }
            });
        };

        const sourceTabId = sender?.tab?.id;
        if (!sourceTabId) {
            capture(null);
        } else {
            chrome.tabs.get(sourceTabId, (tab) => {
                if (chrome.runtime.lastError) {
                    sendResponse({ error: chrome.runtime.lastError.message });
                } else if (tab.active === false) {
                    sendResponse({ error: 'Agent tab is not active' });
                } else {
                    capture(tab.windowId);
                }
            });
        }
        return true; // async
    }

    if (request.type === 'LOCAL_OCR_RECOGNIZE') {
        const image = typeof request.image === 'string' ? request.image : '';
        if (!/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(image)) {
            sendResponse({ ok: false, reason: 'OCR_IMAGE_INVALID' });
            return false;
        }
        offscreenRuntime.recognizeOcr(image).then(sendResponse).catch(() => {
            sendResponse({ ok: false, reason: 'OCR_OFFSCREEN_UNAVAILABLE' });
        });
        return true;
    }

    // START_GOAL_AGENT (with goal) — primary entry point from popup
    if (request.type === 'START_GOAL_AGENT') {
        const tabId = sender?.tab?.id || request.tabId;
        if (!tabId) { sendResponse({ error: 'No tab ID' }); return false; }
        const requestedMessageKey = messageTextKeyFromGoal(request.goal);
        const priorMessage = getMessageGuard(tabId, requestedMessageKey);
        if (priorMessage) {
            sendResponse({
                started: false,
                alreadySubmitted: true,
                error: `A matching message was already ${priorMessage.status === 'confirmed' ? 'sent' : 'submitted'}; not sending it again.`
            });
            return false;
        }
        const existing = loops.get(tabId);
        const requestedGoal = String(request.goal || '').trim();
        if (existing?.running) {
            // Starting the exact same goal again can replay a side effect while
            // the first loop is between observation and action. Require an
            // explicit Stop before retrying that goal. A different goal is an
            // intentional replacement and may stop the old loop.
            if (requestedGoal && requestedGoal === String(existing.goal || '').trim()) {
                sendResponse({ started: true, alreadyRunning: true });
                return false;
            }
            existing.stop();
        }
        const loop = new AgentLoop(tabId, request.goal || '', {
            onMessageSubmitted: ({ text, method }) => setMessageGuard(tabId, text, 'submitted', method),
            onMessageConfirmed: ({ text }) => setMessageGuard(tabId, text, 'confirmed'),
            onMessageUnconfirmed: ({ text, method }) => setMessageGuard(tabId, text, 'uncertain', method)
        });
        loops.set(tabId, loop);
        void loop.start().catch(() => {
            loop.stop();
            chrome.runtime.sendMessage({
                type: 'AGENT_UPDATE',
                status: 'error',
                error: 'Agent loop failed to start'
            }, () => void chrome.runtime.lastError);
        });
        sendResponse({ started: true });
        return false;
    }

    // START_AGENT (no goal — kept for backwards compat / test triggers)
    if (request.type === 'START_AGENT') {
        const tabId = sender?.tab?.id || request.tabId;
        if (!tabId) { sendResponse({ error: 'No tab ID' }); return false; }
        const existing = loops.get(tabId);
        if (existing?.running) existing.stop();
        const loop = new AgentLoop(tabId, request.goal || '');
        loops.set(tabId, loop);
        void loop.start().catch(() => {
            loop.stop();
            chrome.runtime.sendMessage({
                type: 'AGENT_UPDATE',
                status: 'error',
                error: 'Agent loop failed to start'
            }, () => void chrome.runtime.lastError);
        });
        sendResponse({ started: true });
        return false;
    }

    if (request.type === 'STOP_AGENT') {
        const tabId = sender?.tab?.id || request.tabId;
        const loop = loops.get(tabId);
        if (loop) { loop.stop(); loops.delete(tabId); }
        sendResponse({ stopped: true });
        return false;
    }

    return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
        const existing = loops.get(tabId);
        if (existing && existing.running) {
            console.log('Page navigated, resuming agent loop for tab', tabId);
            // Must not call start() while running — that previously no-op'd and stalled the loop
            existing.continueAfterNavigation();
        }
    }
});
