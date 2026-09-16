
// Caveman background
console.log("Service Worker Active");
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'PING') {
        sendResponse({status: 'PONG'});
    }
    if (request.type === 'LOG') {
        console.log(`[LOG]`, request.payload);
        sendResponse({status: 'LOG_RECEIVED'});
    }
    
    if (request.type === 'CAPTURE_TAB') {
        chrome.tabs.captureVisibleTab(null, {format: 'jpeg', quality: 80}, (dataUri) => {
            sendResponse({ dataUri });
        });
    }
    return true; // async

});
