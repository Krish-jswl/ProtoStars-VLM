
import { Logger } from '../shared/logger.js';
import { Config } from '../shared/config.js';
import { APIClient } from './api_client.js';

const logger = new Logger('AgentLoop');

const MAX_ACTIONS_PER_CYCLE = 5;
const MAX_CYCLES = 20;
const BACKOFF_BASE_MS = 500;

export class AgentLoop {
    constructor(tabId, goal = '') {
        this.goal = goal;
        this.tabId = tabId;
        this.client = new APIClient(Config.backendUrl);
        this.cycleCount = 0;
        this.lastActions = [];
        this.running = false;
        this._generation = 0;
    }

    async start() {
        this.running = true;
        this.cycleCount = 0;
        this.lastActions = [];
        this._generation += 1;
        const gen = this._generation;
        logger.info('Agent loop started');
        await this._cycle(gen);
    }

    stop() {
        this.running = false;
        this._generation += 1; // invalidate in-flight cycles
        logger.info('Agent loop stopped');
    }

    /** Continue after navigation without resetting cycle budget entirely. */
    continueAfterNavigation() {
        if (!this.running) return;
        this.lastActions = [];
        this._generation += 1;
        const gen = this._generation;
        logger.info('Page navigated — resuming agent loop');
        setTimeout(() => {
            if (this.running && this._generation === gen) {
                this._cycle(gen);
            }
        }, 800);
    }

    async _cycle(gen) {
        if (gen !== this._generation) return;

        if (!this.running || this.cycleCount >= MAX_CYCLES) {
            logger.info(`Loop ended after ${this.cycleCount} cycles`);
            this.running = false;
            this._broadcast({ type: 'AGENT_UPDATE', status: 'done', cycle: this.cycleCount });
            return;
        }
        this.cycleCount++;
        const traceId = crypto.randomUUID();
        const timing = {};
        const t0 = performance.now();

        try {
            // 1. OBSERVE: run privacy pipeline in content script
            const t1 = performance.now();
            const observed = await this._sendToContent('PRIVACY_PIPELINE', {});
            if (gen !== this._generation) return;
            timing.observe = performance.now() - t1;

            if (!observed) {
                logger.warn('No response from content script (not loaded or page restricted).');
                this._broadcast({
                    type: 'AGENT_UPDATE', status: 'error',
                    error: 'Content script not responding. Try reloading the page.',
                    cycle: this.cycleCount
                });
                this.running = false;
                return;
            }

            if (!observed.allowed) {
                logger.warn('Privacy gate blocked. No request sent.', { violations: observed?.violations });
                this._broadcast({
                    type: 'AGENT_UPDATE', status: 'error',
                    error: 'Privacy gate blocked: ' + (observed.violations || []).join(', '),
                    cycle: this.cycleCount
                });
                this.running = false;
                return;
            }

            // 2. REASON: send sanitized context to backend
            const t2 = performance.now();
            observed.sanitizedContext.goal = this.goal;
            const planResult = await this.client.plan(observed.sanitizedContext);
            if (gen !== this._generation) return;
            timing.network = performance.now() - t2;

            if (!planResult.success) {
                logger.error('Backend plan failed', { error: planResult.error });
                this._broadcast({
                    type: 'AGENT_UPDATE',
                    log: 'Backend error: ' + planResult.error,
                    logLevel: 'error',
                    cycle: this.cycleCount
                });
                await this._backoff(gen);
                return;
            }

            // 3. VALIDATE + ACT
            const actions = planResult.actions.slice(0, MAX_ACTIONS_PER_CYCLE);
            let actionsExecuted = 0;

            for (const action of actions) {
                if (gen !== this._generation) return;

                if (this._isDuplicate(action)) {
                    logger.warn('Duplicate action skipped', { type: action.type });
                    continue;
                }

                if (action.type === 'done') {
                    logger.info('Goal achieved!');
                    this.stop();
                    this._broadcast({ type: 'AGENT_UPDATE', status: 'done', cycle: this.cycleCount });
                    break;
                }

                const t3 = performance.now();
                const result = await this._sendToContent('EXECUTE_VALIDATED_ACTION', { action });
                timing.action = performance.now() - t3;

                if (!result || !result.success) {
                    logger.warn('Action failed or rejected', { reason: result?.error, type: action.type, target: action.target });
                    this._broadcast({
                        type: 'AGENT_UPDATE',
                        log: `Action failed: ${action.type} → ${result?.error || 'no response'}`,
                        logLevel: 'warn',
                        cycle: this.cycleCount
                    });
                } else {
                    actionsExecuted++;
                    this.lastActions.push(action);
                }
            }

            if (gen !== this._generation) return;

            timing.total = performance.now() - t0;
            logger.info('Cycle complete', { traceId, cycle: this.cycleCount, timing, actionsExecuted });

            // Broadcast update to popup
            this._broadcast({
                type: 'AGENT_UPDATE',
                cycle: this.cycleCount,
                timing,
                actionsExecuted,
                actions,
                screenshot: observed.sanitizedContext?.image || null,
                detections: (observed.redactionPlan || []).map(d => ({
                    type: d.type,
                    token: d.token,
                    confidence: d.confidence,
                    bbox: d.bbox,
                    sources: d.sources
                }))
            });

            // 4. Loop if actions were taken, otherwise finish
            if (actionsExecuted > 0 && this.running) {
                setTimeout(() => this._cycle(gen), 500);
            } else {
                this.running = false;
                this._broadcast({ type: 'AGENT_UPDATE', status: 'done', cycle: this.cycleCount });
            }

        } catch (e) {
            if (gen !== this._generation) return;
            logger.error('Cycle error: ' + e.message);
            this._broadcast({
                type: 'AGENT_UPDATE',
                log: 'Cycle error: ' + e.message,
                logLevel: 'error',
                cycle: this.cycleCount
            });
            await this._backoff(gen);
        }
    }

    _isDuplicate(action) {
        return this.lastActions.some(a => a.type === action.type && a.target === action.target);
    }

    async _backoff(gen) {
        const delay = BACKOFF_BASE_MS * Math.min(this.cycleCount, 8);
        await new Promise(r => setTimeout(r, delay));
        if (this.running && gen === this._generation) await this._cycle(gen);
    }

    // Send a message to the content script and properly handle chrome.runtime.lastError
    _sendToContent(type, payload) {
        return new Promise((resolve) => {
            try {
                chrome.tabs.sendMessage(this.tabId, { type, ...payload }, (response) => {
                    if (chrome.runtime.lastError) {
                        logger.warn('Content script message error: ' + chrome.runtime.lastError.message);
                        resolve(null);
                    } else {
                        resolve(response || null);
                    }
                });
            } catch (e) {
                logger.error('sendMessage threw: ' + e.message);
                resolve(null);
            }
        });
    }

    // Safely broadcast to popup (popup may be closed — that is fine)
    _broadcast(msg) {
        try {
            chrome.runtime.sendMessage(msg, () => {
                // Suppress "no listeners" error when popup is closed
                void chrome.runtime.lastError;
            });
        } catch (e) { /* popup closed */ }
    }
}
