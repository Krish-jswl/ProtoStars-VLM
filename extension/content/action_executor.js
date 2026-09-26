const SAFE_KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown']);

export class ActionExecutor {
    constructor(config) {
        this.config = config || {};
    }

    validateTarget(element, actionType = 'click') {
        if (!element || element.nodeType !== 1) return { valid: false, reason: 'Element not found' };

        const rect = element.getBoundingClientRect();
        if (this.config.actionValidation?.requireVisible !== false) {
            if (rect.width === 0 || rect.height === 0) {
                return { valid: false, reason: 'Element not visible (zero size)' };
            }
            let style;
            try { style = window.getComputedStyle(element); } catch (_) { style = null; }
            if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
                return { valid: false, reason: 'Element not visible (styled)' };
            }
            if (element.closest?.('[aria-hidden="true"]')) {
                return { valid: false, reason: 'Element is hidden from accessibility' };
            }
        }
        if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') {
            return { valid: false, reason: 'Element disabled' };
        }
        if (actionType === 'type_local' &&
            (element.readOnly || element.getAttribute?.('aria-readonly') === 'true')) {
            return { valid: false, reason: 'Element is read-only' };
        }
        return { valid: true };
    }

    /**
     * Build a selector for a plain element ID.  Arbitrary CSS selectors are
     * intentionally not accepted: a planner can never turn a target into a
     * selector injection primitive.
     */
    static selectorForTarget(target) {
        if (target == null || typeof target !== 'string') return null;
        let value = target.trim();
        if (!value) return null;
        if (value.startsWith('#')) value = value.slice(1);
        if (!value) return null;
        if (/[.#\[\](){}>+~,:/\\]/.test(value)) return null;
        if (/^(?:body|html|window|document)$/i.test(value)) return value.toLowerCase();
        const escape = (typeof CSS !== 'undefined' && CSS.escape)
            ? CSS.escape
            : (s) => s.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
        return `#${escape(value)}`;
    }

    execute(actionType, targetSelector, args = {}) {
        const allowed = this.config.actionValidation?.allowedActions || [];
        if (!allowed.includes(actionType)) {
            return { success: false, error: `Action ${actionType} not allowed` };
        }

        if (actionType === 'wait') {
            const requested = Number(args.ms);
            const ms = Number.isFinite(requested) ? Math.max(50, Math.min(5000, requested)) : 500;
            return new Promise(resolve => setTimeout(() => resolve({ success: true }), ms));
        }

        let element = null;
        let selector = targetSelector;
        try {
            const pageTarget = actionType === 'scroll' &&
                (!targetSelector || /^(document|window|body|html)$/i.test(String(targetSelector).replace(/^#/, '')));
            if (pageTarget) {
                if (actionType !== 'scroll') return { success: false, error: 'Page target is not actionable' };
                window.scrollBy({
                    top: Number(args.y) || 0,
                    left: Number(args.x) || 0,
                    behavior: 'smooth'
                });
                return { success: true };
            }

            if (actionType === 'keypress' && (!selector || !String(selector).trim())) {
                element = document.activeElement;
            } else {
                selector = ActionExecutor.selectorForTarget(selector || '');
                if (!selector) return { success: false, error: 'No target specified' };
                element = document.querySelector(selector);
            }
            if (element && actionType !== 'scroll' && typeof element.scrollIntoView === 'function') {
                try { element.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { /* best effort */ }
            }
        } catch (e) {
            return { success: false, error: 'Invalid selector' };
        }

        const validation = this.validateTarget(element, actionType);
        if (!validation.valid) return { success: false, error: validation.reason };

        try {
            switch (actionType) {
                case 'click':
                    if (typeof element.click !== 'function') return { success: false, error: 'Element is not clickable' };
                    element.click();
                    break;
                case 'focus':
                    if (typeof element.focus !== 'function') return { success: false, error: 'Element is not focusable' };
                    element.focus();
                    if (document.activeElement !== element) return { success: false, error: 'Target did not become active' };
                    break;
                case 'scroll':
                    element.scrollBy({
                        top: Number(args.y) || 0,
                        left: Number(args.x) || 0,
                        behavior: 'smooth'
                    });
                    break;
                case 'select': {
                    const tag = element.tagName?.toLowerCase();
                    if (tag !== 'select') return { success: false, error: 'select action requires a <select> element' };
                    const wanted = args.value ?? args.text;
                    if (wanted == null || wanted === '') return { success: false, error: 'select requires args.value or args.text' };
                    const wantedStr = String(wanted);
                    const option = Array.from(element.options || []).find(item =>
                        item.value === wantedStr || item.text === wantedStr || item.label === wantedStr
                    );
                    if (!option) return { success: false, error: 'No matching option' };
                    element.value = option.value;
                    this._dispatch(element, 'input');
                    this._dispatch(element, 'change');
                    if (element.value !== option.value) return { success: false, error: 'Selection did not apply' };
                    break;
                }
                case 'keypress': {
                    const key = args.key;
                    if (!SAFE_KEYS.has(key)) return { success: false, error: 'Key is not allowed' };
                    const result = this._pressKey(element, key);
                    if (!result.success) return result;
                    break;
                }
                default:
                    return { success: false, error: 'Unknown action' };
            }
            return { success: true };
        } catch (e) {
            return { success: false, error: 'Action could not be completed' };
        }
    }

    _isEditableElement(element) {
        const tag = element?.tagName?.toLowerCase();
        if (['input', 'textarea', 'select', 'button', 'a'].includes(tag)) {
            return ['input', 'textarea'].includes(tag);
        }
        const raw = element?.getAttribute?.('contenteditable');
        if (raw !== null && raw !== undefined) {
            const value = String(raw).toLowerCase();
            return value === '' || value === 'true' || value === 'plaintext-only';
        }
        const ancestor = element?.closest?.('[contenteditable]');
        if (ancestor && ancestor !== element) {
            const value = String(ancestor.getAttribute('contenteditable') || '').toLowerCase();
            return value === '' || value === 'true' || value === 'plaintext-only';
        }
        return false;
    }

    _dispatch(element, type) {
        const view = element.ownerDocument?.defaultView || window;
        const EventCtor = view.Event || Event;
        element.dispatchEvent(new EventCtor(type, { bubbles: true }));
    }

    _pressKey(element, key) {
        const view = element.ownerDocument?.defaultView || window;
        const KeyboardCtor = view.KeyboardEvent || KeyboardEvent;
        const init = { key, code: key, bubbles: true, cancelable: true, composed: true };
        const tag = element.tagName?.toLowerCase();
        const editable = ['input', 'textarea'].includes(tag) ||
            this._isEditableElement(element);
        // A targeted Enter should reach a freshly re-rendered editor even if
        // the page moved focus while the previous action was settling.
        if (editable && typeof element.focus === 'function') {
            try { element.focus(); } catch (_) { /* best effort */ }
        }
        const form = element.form || element.closest?.('form');
        let submitSeen = false;
        const onSubmit = () => { submitSeen = true; };
        form?.addEventListener?.('submit', onSubmit, true);
        try {
            const keydownAllowed = element.dispatchEvent(new KeyboardCtor('keydown', init));
            element.dispatchEvent(new KeyboardCtor('keypress', init));
            element.dispatchEvent(new KeyboardCtor('keyup', init));
            // Synthetic keyboard events do not trigger a browser's default
            // form submission in all engines.  The fallback is limited to an
            // active editable control, and is skipped when the page handled
            // the key event (preventDefault) or synchronously submitted.
            if (key === 'Enter' && editable && form && keydownAllowed && !submitSeen &&
                typeof form.requestSubmit === 'function') {
                form.requestSubmit();
            }
            return { success: true };
        } catch (_) {
            return { success: false, error: 'Key event could not be dispatched' };
        } finally {
            form?.removeEventListener?.('submit', onSubmit, true);
        }
    }
}
