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
    screenshotDataUri: null,
    route: 'idle',
    model: '—',
    modelStatus: 'idle',
    routeDetail: 'The route will appear when the agent starts.'
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
const routeMini = document.getElementById('route-mini');
const routeLive = document.getElementById('route-live');
const routeIndicator = document.getElementById('route-indicator');
const routeLabel = document.getElementById('route-label');
const routeDetail = document.getElementById('route-detail');
const modelBadge = document.getElementById('model-badge');
const executionBadge = document.getElementById('execution-badge');

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

const ROUTE_META = {
    idle: { label: 'Idle', short: 'IDLE', model: '—', execution: '—' },
    local: { label: 'Local browser planner', short: 'LOCAL', model: 'None (local rules)', execution: 'Browser' },
    'local-vision': { label: 'Local vision model', short: 'LOCAL VLM', model: 'Local VLM', execution: 'Browser' },
    privacy: { label: 'Local privacy pipeline', short: 'PRIVACY', model: 'Local OCR/PII', execution: 'Browser' },
    server: { label: 'Backend server planner', short: 'SERVER', model: 'Configured server provider', execution: 'Browser actions' }
};
const MODEL_LABELS = {
    'local-rules': 'None (local rules)',
    'local-vlm': 'Local VLM',
    'local-privacy': 'Local OCR/PII',
    'server-vlm': 'Configured server provider',
    'server-provider': 'Configured server provider'
};

function setRouteState(route = 'idle', modelStatus = 'idle', detail = '', model = '') {
    const normalizedRoute = ROUTE_META[route] ? route : 'idle';
    state.route = normalizedRoute;
    state.modelStatus = modelStatus || 'idle';
    state.routeDetail = detail || (normalizedRoute === 'idle'
        ? 'The route will appear when the agent starts.'
        : ROUTE_META[normalizedRoute].label);
    state.model = MODEL_LABELS[model] || model || ROUTE_META[normalizedRoute].model;
    renderRoute();
}

function renderRoute() {
    const meta = ROUTE_META[state.route] || ROUTE_META.idle;
    const status = state.modelStatus || 'idle';
    const statusLabel = status === 'running' ? 'RUNNING' :
        status === 'starting' ? 'STARTING' :
            status === 'done' ? 'COMPLETE' :
                status === 'error' ? 'ERROR' :
                    status === 'unavailable' ? 'UNAVAILABLE' : 'IDLE';
    const routeClass = status === 'error' || status === 'unavailable' ? 'route-error' : state.route;
    if (routeMini) {
        routeMini.className = `route-mini ${routeClass}`;
        routeMini.textContent = meta.short;
    }
    if (routeLive) {
        routeLive.className = `route-live ${routeClass}`;
        routeLive.textContent = statusLabel;
    }
    if (routeIndicator) routeIndicator.className = `route-indicator ${routeClass}`;
    if (routeLabel) {
        routeLabel.textContent = state.route === 'idle'
            ? 'No task running'
            : status === 'done' ? `${meta.label} complete` : meta.label;
    }
    if (routeDetail) routeDetail.textContent = state.routeDetail;
    if (modelBadge) {
        modelBadge.className = `route-badge ${routeClass === 'idle' ? 'route-neutral' : routeClass}`;
        modelBadge.textContent = `Model: ${state.model}`;
    }
    if (executionBadge) {
        executionBadge.className = `route-badge ${routeClass === 'idle' ? 'route-neutral' : routeClass}`;
        executionBadge.textContent = `Execution: ${meta.execution}`;
    }
}

function routeFromSource(source) {
    if (source === 'local') return 'local';
    if (source === 'local-vision') return 'local-vision';
    if (source === 'server') return 'server';
    return '';
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
    renderRoute();
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

/** Confirm that the content-script world has the Tesseract runtime. */
/** Generate a local-only privacy preview for the popup. */
async function loadPrivacyPreview(tabId) {
    setRouteState('privacy', 'running', 'Detecting and redacting PII locally before task execution');
    const preview = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'PRIVACY_PREVIEW' }, (response) => {
            void chrome.runtime.lastError;
            resolve(response || null);
        });
    });
    if (!preview) {
        addLog('Local privacy preview unavailable; continuing with browser-local action planning.', 'warn');
        return;
    }
    if (Array.isArray(preview.detections)) {
        state.detections = preview.detections;
        state.piiCount = preview.detections.length;
        state.redactedCount = preview.detections.length;
    }
    if (preview.screenshot) state.screenshotDataUri = preview.screenshot;
    if (preview.timing && typeof preview.timing === 'object') {
        state.timing = { ...state.timing, ...preview.timing };
    }
    if (preview.allowed) {
        addLog(`Local privacy preview ready: ${state.piiCount} PII region(s) redacted.`);
        setRouteState('privacy', 'done', 'Local redaction complete; task planner is starting');
    } else {
        addLog('Local privacy preview could not be verified; no screenshot was shown.', 'warn');
        setRouteState('privacy', 'error', 'Privacy preview failed closed; no screenshot was shown');
    }
    renderAll();
}

function ensureOCRRuntime(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'OCR_RUNTIME_STATUS' }, (response) => {
            if (chrome.runtime.lastError) {
                resolve(false);
            } else {
                resolve(!!response?.available);
            }
        });
    });
}

// ── Go button ─────────────────────────────────────────────────────────────────
goBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const goal = goalInput ? goalInput.value.trim() : '';
    if (!goal) {
        addLog('Enter a command before starting the agent.', 'warn');
        setStatus('Enter a goal', 'idle');
        return;
    }
    if (/\b(?:log\s*in|login|sign\s*in|signin)\b/i.test(goal) &&
        (!secretEmail?.value || !secretPassword?.value)) {
        addLog('Login fields are empty in the popup. Browser-autofill can be used; otherwise enter local email/password above. Values stay in this browser.', 'warn');
    }

    // Persist local secrets for type_local (never sent to backend)
    const secrets = {};
    if (secretEmail?.value) secrets.email = secretEmail.value;
    if (secretPassword?.value) secrets.password = secretPassword.value;
    if (Object.keys(secrets).length) {
        await chrome.storage.local.set({ pva_secrets: secrets });
    }

    addLog('Starting agent...');
    setStatus('Starting...', 'running');
    setRouteState('local', 'starting', 'Preparing the browser-local planner');

    // 1. Ensure content script is present, inject if missing
    const isLoaded = await ensureContentScript(tab.id);
    if (!isLoaded) {
        addLog('Content script not loaded — injecting...', 'warn');
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: [
                    'lib/tesseract/tesseract.min.js',
                    'content/content_bundle.js'
                ]
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

    // A content bundle injected into an already-open tab may predate the
    // manifest's Tesseract entry. Load the worker runtime separately in that
    // case so a selective OCR request does not fail closed with a missing
    // library.
    if (!(await ensureOCRRuntime(tab.id))) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['lib/tesseract/tesseract.min.js']
            });
            addLog('OCR runtime loaded.', 'info');
        } catch (e) {
            // The privacy pipeline will still fail closed if OCR is required.
            addLog('OCR runtime could not be loaded: ' + e.message, 'warn');
        }
    }

    // Generate a redacted local-only preview before starting the action loop.
    // This never contacts the backend; it only populates the popup UI.
    addLog('Generating local privacy preview...');
    await loadPrivacyPreview(tab.id);

    // Push secrets into the content-script LocalSecretProvider
    if (Object.keys(secrets).length) {
        await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { type: 'SET_SECRETS', secrets }, () => {
                void chrome.runtime.lastError;
                resolve();
            });
        });
    }

    // 2. Start agent loop in service worker (passes goal — uses START_GOAL_AGENT).
    //    The local preview above is UI-only; the loop uses its own gated path
    //    if/when it needs the backend.
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
                setRouteState('local', 'starting', 'Planner started; waiting for the execution route');
                addLog(response.alreadyRunning
                    ? 'Agent already running; duplicate start ignored.'
                    : 'Agent loop started ✅');
            } else if (response?.error) {
                addLog('Failed to start: ' + response.error, 'error');
                setStatus('Error', 'error');
                setRouteState(state.route, 'error', response.error, state.model);
            } else {
                addLog('Unexpected response: ' + JSON.stringify(response), 'warn');
                setStatus('Error', 'error');
                setRouteState(state.route, 'error', 'The service worker returned an unexpected response', state.model);
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
        setRouteState('idle', 'idle', 'The task was stopped by the user');
        addLog('Agent stopped');
        renderAll();
    });
});

function updateRouteFromMessage(msg) {
    const sourceRoute = routeFromSource(msg.source);
    const route = msg.route || sourceRoute;
    if (route) {
        let status = msg.modelStatus || 'running';
        if (msg.status === 'done') status = 'done';
        if (msg.status === 'error') status = 'error';
        setRouteState(route, status, msg.routeDetail || '', msg.model || '');
    } else if (msg.status === 'error') {
        setRouteState(state.route, 'error', msg.error || 'The agent reported an error', state.model);
    } else if (msg.status === 'done') {
        setRouteState(state.route, 'done', 'Task completed', state.model);
    }
}

// ── Listen for agent loop updates from background ─────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'AGENT_UPDATE') {
        updateRouteFromMessage(msg);
        if (msg.cycle) state.cycles = msg.cycle;
        if (msg.timing) state.timing = msg.timing;
        if (msg.localVision && Object.keys(msg.localVision).length > 0) {
            const vision = msg.localVision;
            const timing = vision.totalMs != null ? `, ${Math.round(vision.totalMs)}ms` : '';
            addLog(`Local vision: ${vision.backend || 'unknown'} (${vision.status || 'unknown'}${timing})`, 'info');
        }
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
        } else if (msg.cycle && msg.actionsExecuted !== undefined) {
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
    state = { running: false, elements: 0, piiCount: 0, redactedCount: 0, actionCount: 0, cycles: 0, timing: {}, detections: [], actions: [], logs: [], screenshotDataUri: null, route: 'idle', model: '—', modelStatus: 'idle', routeDetail: 'The route will appear when the agent starts.' };
    setStatus('Idle', 'idle');
    renderAll();
});

// Init
renderAll();
