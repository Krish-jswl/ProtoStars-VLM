import { validateActionPlan } from './api_client.js';
import { resolveActionTarget } from './action_grounding.js';
import {
    LOCAL_VISION_MAX_ACTIONS,
    containsSensitiveLiteral,
    prepareLocalDomMetadata
} from '../local_agent/local_vision_protocol.js';

const COMPLEX_GOAL_PATTERN = /\b(?:compare|cheapest|best|research|summari[sz]e|explain|investigate|workflow|multi[- ]?step|book(?:ing)?|purchase|checkout|complete\s+(?:the\s+)?booking|plan\s+(?:a|the)\s+(?:trip|flight|journey)|reason(?:ing)?)\b/i;
const LOCAL_ONLY_ACTION_TYPES = new Set(['click', 'focus', 'scroll', 'select', 'wait', 'keypress', 'type_local', 'done']);
const SECRET_REF_PATTERN = /^\[?(?:email|phone|username|password)(?:_\d+)?\]?$/i;

function finiteMetric(value) {
    return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null;
}

function safeMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return {};
    return {
        backend: ['webgpu', 'wasm'].includes(metrics.backend) ? metrics.backend : 'unknown',
        status: typeof metrics.status === 'string' ? metrics.status.slice(0, 64) : 'unknown',
        coldInitMs: finiteMetric(metrics.coldInitMs),
        warmInferenceMs: finiteMetric(metrics.warmInferenceMs),
        preprocessMs: finiteMetric(metrics.preprocessMs),
        totalMs: finiteMetric(metrics.totalMs),
        inferenceCount: finiteMetric(metrics.inferenceCount),
        memoryBytes: finiteMetric(metrics.memoryBytes)
    };
}

function actionKey(action) {
    let args = '';
    try {
        args = JSON.stringify(action.args || {});
    } catch (_) {
        args = String(action.args);
    }
    return `${action.type}|${action.target}|${args}`;
}

function isVisibleNode(node) {
    return node && node.visible !== false && node.enabled !== false;
}

/**
 * Policy and trust-boundary adapter for the browser-local vision model.
 * Transformers.js is intentionally injected: this class never talks to a
 * model directly and never receives raw secret values.
 */
export class LocalVisionAgent {
    constructor({ runtime = null, validator = validateActionPlan, maxActions = LOCAL_VISION_MAX_ACTIONS } = {}) {
        this.runtime = runtime;
        this.validator = validator;
        this.maxActions = Math.max(1, Math.min(Number(maxActions) || LOCAL_VISION_MAX_ACTIONS, 8));
    }

    shouldAttempt(goal, deterministicDecision = {}) {
        const value = String(goal || '').trim();
        if (!value || value.length > 500 || deterministicDecision.blockEscalation) return false;
        if (containsSensitiveLiteral(value)) return false;
        if (String(deterministicDecision.reason || '').toLowerCase().includes('complex reasoning')) return false;
        // General comparison/planning tasks are intentionally not sent to a
        // 256M model. Visually ambiguous simple requests still reach it.
        if (COMPLEX_GOAL_PATTERN.test(value)) return false;
        return true;
    }

    async analyze(goal, observation = {}, { signal } = {}) {
        const value = String(goal || '').trim();
        const domElements = Array.isArray(observation.dom)
            ? observation.dom
            : Array.isArray(observation.elements)
                ? observation.elements
                : [];
        const image = typeof observation.image === 'string' ? observation.image : '';

        if (!this.shouldAttempt(value, { reason: '' }) || !image || domElements.length === 0) {
            return this._server('local vision input unavailable');
        }
        if (!this.runtime || typeof this.runtime.infer !== 'function') {
            return this._unavailable();
        }

        const input = {
            goal: value,
            // Only bounded metadata is sent to the model. Password contents and
            // arbitrary values are never included; the raw screenshot remains
            // inside the extension worker.
            dom: prepareLocalDomMetadata(domElements, 80),
            image,
            ocr: this._safeOcr(observation.ocrResults || observation.ocr || [])
        };

        let result;
        try {
            result = await this.runtime.infer(input, { signal });
        } catch (error) {
            if (error?.name === 'AbortError') return this._server('local vision cancelled');
            return this._unavailable();
        }
        if (!result || result.unavailable) return this._unavailable(result?.metrics);
        if (result.abstained || result.decision === 'SERVER') {
            return this._server('local vision abstained', result.metrics);
        }

        const candidate = Array.isArray(result.actions)
            ? result.actions
            : Array.isArray(result.plan?.actions)
                ? result.plan.actions
                : null;
        if (!candidate) return this._server('local vision returned no plan', result.metrics);

        const validated = this.validator(candidate);
        if (!validated.ok) return this._server('local vision plan failed validation', result.metrics);
        const actions = validated.actions;
        if (actions.length > this.maxActions) {
            return this._server('local vision plan exceeds safe action limit', result.metrics);
        }
        const doneIndexes = actions
            .map((action, index) => action.type === 'done' ? index : -1)
            .filter(index => index >= 0);
        if (doneIndexes.length !== 1 || doneIndexes[0] !== actions.length - 1) {
            return this._server('local vision plan is not terminal', result.metrics);
        }
        if (!this._safeForLocalExecution(actions, domElements)) {
            return this._server('local vision plan was not safely grounded', result.metrics);
        }

        const seen = new Set();
        for (const action of actions) {
            const key = actionKey(action);
            if (seen.has(key) && action.type !== 'done') {
                return this._server('local vision plan repeats an action', result.metrics);
            }
            seen.add(key);
        }
        const executable = actions.filter(action => action.type !== 'done');
        if (executable.filter(action => action.type === 'wait').length > 1 ||
            executable.every(action => action.type === 'wait')) {
            return this._server('local vision plan contains an unbounded wait', result.metrics);
        }

        return {
            decision: 'LOCAL',
            reason: 'local vision produced a validated grounded plan',
            actions,
            metrics: safeMetrics(result.metrics)
        };
    }

    async status() {
        if (typeof this.runtime?.status !== 'function') return { ok: false, metrics: {} };
        try {
            return await this.runtime.status();
        } catch (_) {
            return { ok: false, metrics: {} };
        }
    }

    async dispose() {
        if (typeof this.runtime?.dispose === 'function') {
            try {
                await this.runtime.dispose();
            } catch (_) {
                // Disposal is best effort and must not affect the agent loop.
            }
        }
    }

    _isIdentityNode(node) {
        if (!node) return false;
        const inputType = String(node.inputType || '').toLowerCase();
        const autocomplete = String(node.autocomplete || '').toLowerCase();
        const identity = [node.id, node.name, node.ariaLabel, node.placeholder, node.label, node.title, node.testId]
            .filter(Boolean).join(' ').toLowerCase();
        return ['email', 'password', 'tel', 'url'].includes(inputType) ||
            ['email', 'username', 'tel', 'search', 'current-password', 'new-password'].includes(autocomplete) ||
            /\b(?:e[-\s]?mail|username|user\s*name|user\s*id|account|login|log\s*in|sign\s*in|credential|phone|telephone)\b/.test(identity);
    }

    _safeForLocalExecution(actions, domElements) {
        const nodes = new Map();
        for (const node of Array.isArray(domElements) ? domElements : []) {
            if (isVisibleNode(node) && node.id) nodes.set(String(node.id).replace(/^#/, ''), node);
        }
        for (const action of actions) {
            if (!LOCAL_ONLY_ACTION_TYPES.has(action.type)) return false;
            if (action.type === 'done' || action.type === 'wait') continue;
            if (action.type === 'scroll') {
                const target = String(action.target || 'body').replace(/^#/, '').toLowerCase();
                if (target && !['body', 'html', 'window', 'document'].includes(target)) return false;
                continue;
            }
            if (action.type === 'keypress') {
                if (Object.keys(action.args || {}).some(key => key !== 'key')) return false;
                if (!['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown'].includes(action.args?.key)) return false;
                if (!action.target) continue;
            }
            const target = String(action.target || '').replace(/^#/, '');
            if (!target || !nodes.has(target)) return false;
            if (resolveActionTarget(action, [...nodes.values()]).status !== 'resolved') return false;
            if (action.type === 'type_local') {
                if (typeof action.args?.secret_ref === 'string') {
                    if (!SECRET_REF_PATTERN.test(action.args.secret_ref) ||
                        Object.keys(action.args).some(key => key !== 'secret_ref')) return false;
                } else {
                    const value = action.args?.text ?? action.args?.value;
                    if (typeof value !== 'string' || !value.trim() || value.length > 2000 ||
                        containsSensitiveLiteral(value) ||
                        Object.keys(action.args || {}).some(key => !['text', 'value'].includes(key)) ||
                        this._isIdentityNode(nodes.get(target))) return false;
                }
            }
            for (const [key, value] of Object.entries(action.args || {})) {
                if (key !== 'secret_ref' && containsSensitiveLiteral(String(value))) return false;
            }
        }
        return true;
    }

    _safeOcr(items) {
        return (Array.isArray(items) ? items : [])
            .filter(item => {
                const value = String(item?.text || '');
                return value &&
                    !containsSensitiveLiteral(value) &&
                    !/\b(?:password|passwd|secret|token|api[_ -]?key|private[_ -]?key)\b/i.test(value);
            })
            .slice(0, 60)
            .map(item => ({
                text: String(item.text).slice(0, 160),
                bbox: item?.bbox && typeof item.bbox === 'object' ? {
                    x: Number(item.bbox.x) || 0,
                    y: Number(item.bbox.y) || 0,
                    width: Number(item.bbox.width) || 0,
                    height: Number(item.bbox.height) || 0
                } : null
            }));
    }

    _unavailable(metrics) {
        return {
            decision: 'SERVER',
            reason: 'LOCAL_VISION_UNAVAILABLE',
            localVisionUnavailable: true,
            metrics: safeMetrics(metrics),
            actions: []
        };
    }

    _server(reason, metrics) {
        return {
            decision: 'SERVER',
            reason,
            localVisionRejected: true,
            metrics: safeMetrics(metrics),
            actions: []
        };
    }
}
