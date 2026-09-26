import { Logger } from '../shared/logger.js';
import { isSafeElementId, SAFE_KEYS } from './action_grounding.js';

const logger = new Logger('APIClient');

export const MAX_ACTION_PLAN_LENGTH = 12;

export const ALLOWED_ACTION_TYPES = new Set([
    'click',
    'scroll',
    'focus',
    'select',
    'wait',
    'keypress',
    'type_local',
    'done'
]);

function safeString(value, max = 20000) {
    return typeof value === 'string' && value.length <= max &&
        !/javascript\s*:|<\s*script|\beval\s*\(/i.test(value);
}

function validSecretRef(value) {
    return typeof value === 'string' &&
        /^\[?(?:email|phone|username|password)(?:_\d+)?\]?$/i.test(value);
}

function normalizeTarget(type, value) {
    let target = value == null ? '' : value;
    if (typeof target !== 'string' || target.length > 2048) {
        return { error: 'Malformed action target' };
    }
    if (target && /javascript\s*:|<\s*script|\beval\s*\(/i.test(target)) {
        return { error: 'Malicious target detected' };
    }
    if (['done', 'wait'].includes(type)) target = '';
    if (type === 'scroll' && !target) target = 'body';
    if (!['done', 'wait', 'scroll', 'keypress'].includes(type) && !target) {
        return { error: 'Action target is required' };
    }
    const pageTarget = ['body', 'html', 'window', 'document'].includes(target.replace(/^#/, '').toLowerCase());
    if (pageTarget && type !== 'scroll') {
        return { error: 'Page-level targets are only valid for scroll' };
    }
    if (target && !isSafeElementId(target) && !pageTarget) {
        return { error: 'Only element IDs are allowed as targets' };
    }
    return { target: target.replace(/^#/, '') || target };
}

function normalizeArgs(type, args) {
    const safe = {};
    for (const [key, value] of Object.entries(args || {})) {
        if (!/^[A-Za-z0-9_]{1,64}$/.test(key) ||
            ['__proto__', 'prototype', 'constructor'].includes(key.toLowerCase())) {
            return { error: 'Malformed action argument key' };
        }
        if (['code', 'script', 'javascript', 'expression'].includes(key.toLowerCase())) {
            return { error: 'Executable action arguments are not allowed' };
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
            return { error: 'Action argument number must be finite' };
        }
        if (value !== null && typeof value !== 'string' &&
            typeof value !== 'number' && typeof value !== 'boolean') {
            return { error: 'Unsupported action argument value' };
        }
        if (typeof value === 'string' && !safeString(value)) {
            return { error: value.length > 20000 ? 'Action argument is too long' : 'Malicious action argument detected' };
        }
        safe[key] = value;
    }

    if (type === 'click' || type === 'focus') {
        if (Object.keys(safe).length) return { error: `Arguments are not allowed for ${type}` };
        return { args: safe };
    }

    if (type === 'done') {
        if (Object.keys(safe).some(key => !['reason'].includes(key))) {
            return { error: 'Invalid done arguments' };
        }
        if (safe.reason != null && !safeString(safe.reason, 200)) return { error: 'Invalid done reason' };
        return { args: safe };
    }

    if (type === 'wait') {
        if (Object.keys(safe).some(key => !['ms', 'reason'].includes(key))) {
            return { error: 'Invalid wait arguments' };
        }
        const ms = safe.ms == null ? 500 : Number(safe.ms);
        if (!Number.isFinite(ms)) return { error: 'Invalid wait duration' };
        safe.ms = Math.max(50, Math.min(5000, Math.round(ms)));
        if (safe.reason != null && !safeString(safe.reason, 200)) return { error: 'Invalid wait reason' };
        return { args: safe };
    }

    if (type === 'scroll') {
        if (Object.keys(safe).some(key => !['x', 'y'].includes(key))) {
            return { error: 'Invalid scroll arguments' };
        }
        const x = safe.x == null ? 0 : Number(safe.x);
        const y = safe.y == null ? 0 : Number(safe.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'Invalid scroll amount' };
        safe.x = Math.max(-10000, Math.min(10000, Math.round(x)));
        safe.y = Math.max(-10000, Math.min(10000, Math.round(y)));
        return { args: safe };
    }

    if (type === 'select') {
        if (Object.keys(safe).some(key => !['value', 'text'].includes(key)) ||
            (safe.value == null && safe.text == null)) {
            return { error: 'Select requires one value or text argument' };
        }
        if (safe.value != null && !safeString(String(safe.value), 2000)) return { error: 'Invalid select value' };
        if (safe.text != null && !safeString(String(safe.text), 2000)) return { error: 'Invalid select text' };
        return { args: safe };
    }

    if (type === 'keypress') {
        if (Object.keys(safe).some(key => key !== 'key') || !SAFE_KEYS.includes(safe.key)) {
            return { error: 'Only allowlisted navigation keys may be pressed' };
        }
        return { args: { key: safe.key } };
    }

    if (type === 'type_local') {
        const keys = Object.keys(safe);
        if (keys.some(key => !['secret_ref', 'text', 'value'].includes(key))) {
            return { error: 'Invalid type_local arguments' };
        }
        if (safe.secret_ref != null) {
            if (!validSecretRef(safe.secret_ref) || keys.some(key => key !== 'secret_ref')) {
                return { error: 'Invalid local secret reference' };
            }
            return { args: { secret_ref: safe.secret_ref } };
        }
        const value = safe.text ?? safe.value;
        if (typeof value !== 'string' || value.length > 2000) {
            return { error: 'type_local requires bounded text or a secret reference' };
        }
        return { args: { text: value } };
    }

    return { args: safe };
}

/**
 * Validate and normalize an action plan at the extension trust boundary.
 * Server plans and deterministic local plans both use this exact validator.
 */
export function validateActionPlan(actions) {
    if (!Array.isArray(actions)) return { ok: false, error: 'Missing actions array' };
    if (actions.length > MAX_ACTION_PLAN_LENGTH) {
        return { ok: false, error: 'Too many actions returned' };
    }

    const normalized = [];
    const seenTypeActions = new Set();
    for (const action of actions) {
        if (!action || typeof action !== 'object' || Array.isArray(action)) {
            return { ok: false, error: 'Malformed action returned' };
        }
        const type = action.type ?? action.action;
        if (!ALLOWED_ACTION_TYPES.has(type)) {
            return { ok: false, error: `Illegal action type: ${String(type)}` };
        }

        const targetResult = normalizeTarget(type, action.target ?? action.selector ?? action.element_id ?? '');
        if (targetResult.error) return { ok: false, error: targetResult.error };
        const argsValue = action.args ?? action.parameters ?? {};
        if (typeof argsValue !== 'object' || Array.isArray(argsValue)) {
            return { ok: false, error: 'Malformed action arguments' };
        }
        const argsResult = normalizeArgs(type, argsValue);
        if (argsResult.error) return { ok: false, error: argsResult.error };
        if (type === 'type_local') {
            const typeKey = `${targetResult.target}\u0000${JSON.stringify(argsResult.args)}`;
            if (seenTypeActions.has(typeKey)) {
                return { ok: false, error: 'Duplicate type_local action' };
            }
            seenTypeActions.add(typeKey);
        }

        normalized.push({ type, target: targetResult.target, args: argsResult.args });
    }

    const doneIndexes = normalized
        .map((action, index) => action.type === 'done' ? index : -1)
        .filter(index => index >= 0);
    if (doneIndexes.length > 1 || (doneIndexes.length === 1 && doneIndexes[0] !== normalized.length - 1)) {
        return { ok: false, error: 'done must be the only terminal action and must be last' };
    }

    return { ok: true, actions: normalized };
}

export class APIClient {
    constructor(backendUrl, timeoutMs = 120000, options = {}) {
        this.backendUrl = String(backendUrl || '').replace(/\/+$/, '');
        this.timeoutMs = timeoutMs;
        this.debugMode = options.debugMode === true;
    }

    async plan(sanitizedContext) {
        if (!this.backendUrl) return { success: false, error: 'Backend URL is not configured' };

        const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        // Debug: log what we're sending to the backend
        if (this.debugMode) {
            logger.info('[DEBUG] Sending plan request to backend', {
                goal: sanitizedContext.goal || '(none)',
                domNodes: Array.isArray(sanitizedContext.dom) ? sanitizedContext.dom.length : 0,
                visibleNodes: Array.isArray(sanitizedContext.dom)
                    ? sanitizedContext.dom.filter(n => n.visible !== false).length : 0,
                imageChars: typeof sanitizedContext.image === 'string' ? sanitizedContext.image.length : 0,
                url: (sanitizedContext.page?.url || '').split('?')[0].slice(0, 100),
                domSample: Array.isArray(sanitizedContext.dom)
                    ? sanitizedContext.dom.slice(0, 5).map(n => ({
                        id: n.id, tag: n.tag, role: n.role,
                        text: (n.text || '').slice(0, 40),
                        visible: n.visible, enabled: n.enabled
                      }))
                    : []
            });
        }

        try {
            const res = await fetch(`${this.backendUrl}/v1/agent/plan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
                // Never log or persist the request body. It contains the
                // extension's locally redacted DOM and screenshot.
                body: JSON.stringify(sanitizedContext),
                signal: controller.signal
            });

            let data = null;
            try { data = await res.json(); } catch (_) { /* use status below */ }
            if (!res.ok) {
                logger.warn(`Backend error status: ${res.status}`);
                if (this.debugMode) logger.warn('[DEBUG] Backend HTTP error', { status: res.status, data });
                return { success: false, error: this._httpError(res.status, data) };
            }

            if (this.debugMode) {
                logger.info('[DEBUG] Backend raw response', {
                    providerError: data?.providerError,
                    providerErrorReason: data?.providerErrorReason,
                    actionsCount: Array.isArray(data?.actions) ? data.actions.length : 'N/A',
                    actions: Array.isArray(data?.actions)
                        ? data.actions.map(a => ({ type: a.type, target: a.target, args: a.args }))
                        : data
                });
            }

            // A provider failure must never be executed as a real plan.  The
            // backend reports it explicitly; older builds signalled it by
            // returning a lone ``wait`` action carrying an error reason.
            const providerError = this._extractProviderError(data);
            if (providerError) {
                logger.warn('Backend reported a provider error: ' + providerError);
                return { success: false, error: providerError, providerError: true };
            }

            const actions = this._extractActions(data);
            const validated = this._validateResponse({ actions });
            if (!validated.ok) {
                logger.warn('Backend response failed action validation: ' + validated.error);
                if (this.debugMode) {
                    logger.warn('[DEBUG] Validation failure detail', {
                        error: validated.error,
                        rawActions: actions
                    });
                }
                return { success: false, error: validated.error };
            }
            if (this.debugMode) {
                logger.info('[DEBUG] Validated plan accepted', {
                    actions: validated.actions.map(a => ({ type: a.type, target: a.target }))
                });
            }
            return { success: true, actions: validated.actions };
        } catch (e) {
            if (e.name === 'AbortError') return { success: false, error: 'Request timeout' };
            logger.error('Backend request failed');
            return { success: false, error: 'Connection failure' };
        } finally {
            clearTimeout(timer);
        }
    }

    _httpError(status, data) {
        let detail = '';
        if (data && typeof data.detail === 'string') detail = data.detail.slice(0, 160);
        return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
    }

    _extractProviderError(data) {
        if (!data || typeof data !== 'object') return '';
        if (data.providerError === true) {
            const reason = safeString(String(data.providerErrorReason || ''), 200)
                ? String(data.providerErrorReason).slice(0, 200)
                : '';
            return reason || 'The configured planner provider is unavailable';
        }
        // Legacy compatibility: a single ``wait`` whose reason names a provider
        // problem is an error report, not an instruction to wait.
        const actions = this._extractActions(data);
        if (Array.isArray(actions) && actions.length === 1) {
            const action = actions[0];
            if (action && action.type === 'wait') {
                const reason = String((action.args && action.args.reason) || '').toLowerCase();
                if (['vlm', 'provider', 'quota', 'timeout', 'rate limit']
                    .some(marker => reason.includes(marker))) {
                    return 'The configured planner provider is unavailable';
                }
            }
        }
        return '';
    }

    _extractActions(data) {
        if (Array.isArray(data)) return data;
        if (!data || typeof data !== 'object') return null;
        if (Array.isArray(data.actions)) return data.actions;
        if (Array.isArray(data.action)) return data.action;
        if (data.action && typeof data.action === 'object') return [data.action];
        if (typeof data.action === 'string') {
            return [{
                type: data.action,
                target: data.target || data.selector || data.element_id || '',
                args: data.args || data.parameters || {}
            }];
        }
        if (data.plan && Array.isArray(data.plan.actions)) return data.plan.actions;
        return null;
    }

    _validateResponse(data) {
        return validateActionPlan(data && data.actions);
    }
}
