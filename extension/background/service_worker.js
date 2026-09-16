
import { AgentLoop } from './agent_loop.js';

const loops = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.type === 'PING') {
        sendResponse({ status: 'PONG' });
    }

    if (request.type === 'LOG') {
        console.log('[LOG]', request.payload);
        sendResponse({ status: 'LOG_RECEIVED' });
    }

    if (request.type === 'CAPTURE_TAB') {
        chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 80 }, (dataUri) => {
            sendResponse({ dataUri });
        });
    }

    if (request.type === 'START_AGENT') {
        const tabId = sender.tab?.id || request.tabId;
        if (!tabId) { sendResponse({ error: 'No tab ID' }); return; }
        if (!loops.has(tabId)) {
            const loop = new AgentLoop(tabId);
            loops.set(tabId, loop);
            loop.start();
        }
        sendResponse({ started: true });
    }

    if (request.type === 'STOP_AGENT') {
        const tabId = sender.tab?.id || request.tabId;
        const loop = loops.get(tabId);
        if (loop) { loop.stop(); loops.delete(tabId); }
        sendResponse({ stopped: true });
    }

    return true;
});
