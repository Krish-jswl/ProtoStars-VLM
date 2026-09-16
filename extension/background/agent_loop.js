
import { Logger } from '../shared/logger.js';
import { Config } from '../shared/config.js';
import { APIClient } from './api_client.js';

const logger = new Logger('AgentLoop');

const MAX_ACTIONS_PER_CYCLE = 5;
const MAX_CYCLES = 20;
const BACKOFF_BASE_MS = 500;

export class AgentLoop {
    constructor(tabId) {
        this.tabId = tabId;
        this.client = new APIClient(Config.backendUrl);
        this.cycleCount = 0;
        this.lastActions = [];
        this.running = false;
    }

    async start() {
        if (this.running) return;
        this.running = true;
        this.cycleCount = 0;
        logger.info('Agent loop started');
        await this._cycle();
    }

    stop() {
        this.running = false;
        logger.info('Agent loop stopped');
    }

    async _cycle() {
        if (!this.running || this.cycleCount >= MAX_CYCLES) {
            logger.info(`Loop ended after ${this.cycleCount} cycles`);
            this.running = false;
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
            timing.observe = performance.now() - t1;

            if (!observed || !observed.allowed) {
                logger.warn('Privacy gate blocked. No request sent.', { violations: observed?.violations });
                this.running = false;
                return;
            }

            // 2. REASON: send to backend
            const t2 = performance.now();
            const planResult = await this.client.plan(observed.sanitizedContext);
            timing.network = performance.now() - t2;

            if (!planResult.success) {
                logger.error('Backend plan failed', { error: planResult.error });
                await this._backoff();
                return;
            }

            // 3. VALIDATE + ACT
            const actions = planResult.actions.slice(0, MAX_ACTIONS_PER_CYCLE);
            let actionsExecuted = 0;

            for (const action of actions) {
                // Duplicate action check
                if (this._isDuplicate(action)) {
                    logger.warn('Duplicate action skipped', { type: action.type });
                    continue;
                }

                const t3 = performance.now();
                const result = await this._sendToContent('EXECUTE_VALIDATED_ACTION', { action });
                timing.action = performance.now() - t3;

                if (!result || !result.success) {
                    logger.warn('Action failed or rejected', { reason: result?.error });
                } else {
                    actionsExecuted++;
                    this.lastActions.push(action);
                }
            }

            timing.total = performance.now() - t0;
            logger.info('Cycle complete', { traceId, cycle: this.cycleCount, timing, actionsExecuted });

            // 4. OBSERVE AGAIN if actions executed
            if (actionsExecuted > 0) {
                setTimeout(() => this._cycle(), 500);
            } else {
                this.running = false;
            }

        } catch (e) {
            logger.error('Cycle error');
            await this._backoff();
        }
    }

    _isDuplicate(action) {
        return this.lastActions.some(a => a.type === action.type && a.target === action.target);
    }

    async _backoff() {
        const delay = BACKOFF_BASE_MS * Math.min(this.cycleCount, 8);
        await new Promise(r => setTimeout(r, delay));
        if (this.running) await this._cycle();
    }

    _sendToContent(type, payload) {
        return new Promise((resolve) => {
            chrome.tabs.sendMessage(this.tabId, { type, ...payload }, (response) => {
                resolve(response || null);
            });
        });
    }
}
