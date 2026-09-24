// State
let state = {
    running: false,
    elements: 0,
    piiCount: 0,
    redactedCount: 0,
    actionCount: 0,
    cycles: 0,
    timing: {},
    detections: [],
    actions: [],
    logs: [],
    screenshotDataUri: null
};

// DOM refs
const goBtn = document.getElementById('goBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const clearBtn = document.getElementById('clearBtn');
const goalInput = document.getElementById('goalInput');
const secretEmail = document.getElementById('secretEmail');
const secretPassword = document.getElementById('secretPassword');

// Restore locally-stored credential refs (values stay in chrome.storage, never logged)
chrome.storage.local.get(['pva_secrets'], (data) => {
    const s = data.pva_secrets || {};
    if (secretEmail && s.email) secretEmail.value = s.email;
    if (secretPassword && s.password) secretPassword.value = s.password;
});

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
});

// Set status
function setStatus(text, level) {
    statusText.textContent = text;
    statusDot.className = 'dot dot-' + level;
}

// Add log
function addLog(msg, level) {
    state.logs.unshift({ time: new Date().toLocaleTimeString(), msg, level: level || 'info' });
    if (state.logs.length > 100) state.logs.pop();
    renderLogs();
}

// Badge class for PII type
function badgeClass(type) {
    const map = { EMAIL: 'email', PHONE: 'phone', PERSON: 'person', PASSWORD: 'password', CREDIT_CARD: 'credit', AUTH_TOKEN: 'auth' };
    return 'badge-' + (map[type] || 'default');
}

// Render functions
function renderOverview() {
    document.getElementById('stat-elements').textContent = state.elements;
    document.getElementById('stat-pii').textContent = state.piiCount;
    document.getElementById('stat-redacted').textContent = state.redactedCount;
    document.getElementById('stat-actions').textContent = state.actionCount;
    document.getElementById('cycle-count').textContent = state.cycles;

    const barsEl = document.getElementById('timing-bars');
    const t = state.timing;
    if (!t || !t.total) { barsEl.innerHTML = '<div class="empty-state">No timing data yet</div>'; return; }

    const max = t.total || 1;
    const colors = { dom: '#58a6ff', screenshot: '#bc8cff', pii: '#f0b858', redact: '#f85149', gate: '#3fb950', network: '#d2a8ff' };
    const phases = ['dom', 'screenshot', 'pii', 'redact', 'gate'];
    
    barsEl.innerHTML = phases.filter(p => t[p] !== undefined).map(p => {
        const pct = Math.max(2, (t[p] / max) * 100);
        const color = colors[p] || '#58a6ff';
        return `<div class="timing-bar">
            <div class="timing-bar-label">${p}</div>
            <div class="timing-bar-track"><div class="timing-bar-fill" style="width:${pct}%;background:${color}"></div></div>
            <div class="timing-bar-value">${Math.round(t[p])}ms</div>
        </div>`;
    }).join('');
}

function renderDetections() {
    const el = document.getElementById('detections-list');
    if (!state.detections.length) { el.innerHTML = '<div class="empty-state">No PII detected yet</div>'; return; }
    el.innerHTML = state.detections.map(d => `
        <div class="card">
            <div class="card-header">
                <span class="card-type">${d.type}</span>
                <span class="card-badge ${badgeClass(d.type)}">${Math.round((d.confidence || 0) * 100)}%</span>
            </div>
            <div class="card-token">${d.token || '—'}</div>
            <div class="card-detail">Position: (${d.bbox?.x || 0}, ${d.bbox?.y || 0}) ${d.bbox?.width || 0}×${d.bbox?.height || 0}</div>
        </div>
    `).join('');
}

function renderScreenshot() {
    const img = document.getElementById('redacted-img');
    const empty = document.getElementById('screenshot-empty');
    if (state.screenshotDataUri) {
        img.src = state.screenshotDataUri;
        img.style.display = 'block';
        empty.style.display = 'none';
    } else {
        img.style.display = 'none';
        empty.style.display = 'block';
    }
}

function renderActions() {
    const el = document.getElementById('actions-list');
    if (!state.actions.length) { el.innerHTML = '<div class="empty-state">No actions yet</div>'; return; }
    el.innerHTML = state.actions.map(a => `
        <div class="card">
            <span class="action-type">${a.type}</span>
            <span class="action-target">${a.target || ''}</span>
            ${a.args ? `<div class="card-detail">${JSON.stringify(a.args)}</div>` : ''}
        </div>
    `).join('');
}

function renderLogs() {
    const el = document.getElementById('logs-container');
    if (!state.logs.length) { el.innerHTML = '<div class="empty-state">Waiting for events...</div>'; return; }
    el.innerHTML = state.logs.map(l => `
        <div class="log-entry">
            <span class="log-time">${l.time}</span> <span class="log-${l.level}">${l.msg}</span>
        </div>
    `).join('');
}

function renderAll() {
    renderOverview();
    renderDetections();
    renderScreenshot();
    renderActions();
    renderLogs();
}

// ── Helper: ensure content script is loaded ──────────────────────────────────
async function ensureContentScript(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'ANALYZE_DOM' }, (response) => {
            if (chrome.runtime.lastError || !response) {
                resolve(false);
            } else {
                state.elements = response.elements?.length || 0;
                resolve(true);
            }
        });
    });
}

// ── Go button ─────────────────────────────────────────────────────────────────
goBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const goal = goalInput ? goalInput.value.trim() : '';

    // Persist local secrets for type_local (never sent to backend)
    const secrets = {};
    if (secretEmail?.value) secrets.email = secretEmail.value;
    if (secretPassword?.value) secrets.password = secretPassword.value;
    if (Object.keys(secrets).length) {
        await chrome.storage.local.set({ pva_secrets: secrets });
    }

    addLog('Starting agent' + (goal ? ` with goal: "${goal}"` : '') + '...');
    setStatus('Starting...', 'running');

    // 1. Ensure content script is present, inject if missing
    const isLoaded = await ensureContentScript(tab.id);
    if (!isLoaded) {
        addLog('Content script not loaded — injecting...', 'warn');
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/content_bundle.js']
            });
            addLog('Content script injected. Waiting for init...', 'info');
            await new Promise(r => setTimeout(r, 600));

            // Verify injection worked
            const verified = await ensureContentScript(tab.id);
            if (!verified) {
                addLog('Content script injection failed — cannot run on this page.', 'error');
                setStatus('Error', 'error');
                renderAll();
                return;
            }
        } catch (e) {
            addLog('Injection error: ' + e.message, 'error');
            setStatus('Error', 'error');
            renderAll();
            return;
        }
    } else {
        addLog('Content script active. Found ' + state.elements + ' elements.');
    }

    // Push secrets into the content-script LocalSecretProvider
    if (Object.keys(secrets).length) {
        await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { type: 'SET_SECRETS', secrets }, () => {
                void chrome.runtime.lastError;
                resolve();
            });
        });
    }

    // 2. Start agent loop in service worker (passes goal — uses START_GOAL_AGENT)
    //    The agent loop itself runs the privacy pipeline; we don't duplicate it here.
    chrome.runtime.sendMessage(
        { type: 'START_GOAL_AGENT', tabId: tab.id, goal },
        (response) => {
            if (chrome.runtime.lastError) {
                addLog('Service worker error: ' + chrome.runtime.lastError.message, 'error');
                setStatus('Error', 'error');
                renderAll();
                return;
            }
            if (response?.started) {
                state.running = true;
                goBtn.style.display = 'none';
                stopBtn.style.display = 'flex';
                setStatus('Running', 'running');
                addLog('Agent loop started ✅');
            } else if (response?.error) {
                addLog('Failed to start: ' + response.error, 'error');
                setStatus('Error', 'error');
            } else {
                addLog('Unexpected response: ' + JSON.stringify(response), 'warn');
                setStatus('Error', 'error');
            }
            renderAll();
        }
    );
});

// ── Stop button ───────────────────────────────────────────────────────────────
stopBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    chrome.runtime.sendMessage({ type: 'STOP_AGENT', tabId: tab.id }, () => {
        state.running = false;
        goBtn.style.display = 'flex';
        stopBtn.style.display = 'none';
        setStatus('Stopped', 'idle');
        addLog('Agent stopped');
        renderAll();
    });
});

// ── Listen for agent loop updates from background ─────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'AGENT_UPDATE') {
        if (msg.cycle) state.cycles = msg.cycle;
        if (msg.timing) state.timing = msg.timing;
        if (msg.actionsExecuted !== undefined) state.actionCount += msg.actionsExecuted;
        if (msg.detections) {
            state.detections = msg.detections;
            state.piiCount = msg.detections.length;
            state.redactedCount = msg.detections.length;
        }
        if (msg.actions) {
            state.actions = [...(state.actions), ...msg.actions].slice(-50);
        }
        if (msg.screenshot) {
            state.screenshotDataUri = msg.screenshot;
        }
        if (msg.status === 'done') {
            state.running = false;
            goBtn.style.display = 'flex';
            stopBtn.style.display = 'none';
            setStatus('Done', 'done');
            addLog('Agent loop finished ✅');
        } else if (msg.status === 'error') {
            state.running = false;
            goBtn.style.display = 'flex';
            stopBtn.style.display = 'none';
            setStatus('Error', 'error');
            addLog('Agent error: ' + (msg.error || 'unknown'), 'error');
        } else if (msg.cycle) {
            addLog(`Cycle ${msg.cycle} complete — ${msg.actionsExecuted || 0} action(s)`);
        }
        if (msg.log) {
            addLog(msg.log, msg.logLevel || 'info');
        }
        renderAll();
    }
});

// ── Clear ─────────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    state = { running: false, elements: 0, piiCount: 0, redactedCount: 0, actionCount: 0, cycles: 0, timing: {}, detections: [], actions: [], logs: [], screenshotDataUri: null };
    setStatus('Idle', 'idle');
    renderAll();
});

// Init
renderAll();
