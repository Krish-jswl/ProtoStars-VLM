
document.getElementById('scanBtn').addEventListener('click', async () => {
    const status = document.getElementById('status');
    status.innerText = "Scanning...";
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if(tab) {
        chrome.tabs.sendMessage(tab.id, {type: 'ANALYZE_DOM'}, (response) => {
            status.innerText = response ? `Found ${response.elements.length} elements` : 'Error';
        });
    }
});
