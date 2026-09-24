
import { AgentLoop } from './agent_loop.js';

const loops = new Map();

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
        chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 80 }, (dataUri) => {
            if (chrome.runtime.lastError) {
                sendResponse({ error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ dataUri });
            }
        });
        return true; // async
    }

    // START_GOAL_AGENT (with goal) — primary entry point from popup
    if (request.type === 'START_GOAL_AGENT') {
        const tabId = sender.tab?.id || request.tabId;
        if (!tabId) { sendResponse({ error: 'No tab ID' }); return false; }
        const existing = loops.get(tabId);
        if (existing?.running) existing.stop();
        const loop = new AgentLoop(tabId, request.goal || '');
        loops.set(tabId, loop);
        loop.start();
        sendResponse({ started: true });
        return false;
    }

    // START_AGENT (no goal — kept for backwards compat / test triggers)
    if (request.type === 'START_AGENT') {
        const tabId = sender.tab?.id || request.tabId;
        if (!tabId) { sendResponse({ error: 'No tab ID' }); return false; }
        const existing = loops.get(tabId);
        if (existing?.running) existing.stop();
        const loop = new AgentLoop(tabId, request.goal || '');
        loops.set(tabId, loop);
        loop.start();
        sendResponse({ started: true });
        return false;
    }

    if (request.type === 'STOP_AGENT') {
        const tabId = sender.tab?.id || request.tabId;
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
