
/**
 * LocalSecretProvider — in-memory secret store.
 * Secrets never cross the privacy boundary.
 * Values never appear in logs, telemetry, or network payloads.
 */

const ALLOWED_REFS = new Set(['email', 'phone', 'username', 'password']);

// Valid input types each ref may target
const REF_VALID_INPUTS = {
    email:    new Set(['email', 'text']),
    phone:    new Set(['tel', 'text']),
    username: new Set(['text', 'email']),
    password: new Set(['password'])
};

export class LocalSecretProvider {
    constructor() {
        // In-memory only. No persistence.
        this._secrets = new Map();
    }

    /** Set a secret for development/testing. */
    set(secretRef, value) {
        if (!ALLOWED_REFS.has(secretRef)) {
            throw new Error(`Unknown secret ref: ${secretRef}`);
        }
        if (typeof value !== 'string' || value.length === 0) {
            throw new Error('Secret value must be a non-empty string');
        }
        this._secrets.set(secretRef, value);
    }

    /** Check if a secret ref exists. */
    has(secretRef) {
        return this._secrets.has(secretRef);
    }

    /** Get a secret value. NEVER log the return value. */
    get(secretRef) {
        if (!ALLOWED_REFS.has(secretRef)) {
            return null;
        }
        return this._secrets.get(secretRef) || null;
    }

    /** List available refs (names only, never values). */
    listAvailableRefs() {
        return [...this._secrets.keys()];
    }

    /** Clear all secrets from memory. */
    clear() {
        this._secrets.clear();
    }

    /** Validate that a target element is compatible with a secret ref. */
    static validateTarget(element, secretRef) {
        if (!element) return { valid: false, reason: 'Element not found' };

        const tag = element.tagName?.toLowerCase();
        const isContentEditable = LocalSecretProvider._isContentEditableElement(element);
        if (tag !== 'input' && tag !== 'textarea' && !isContentEditable) {
            return { valid: false, reason: 'Target must be input or textarea' };
        }
        if (isContentEditable && secretRef === 'password') {
            return { valid: false, reason: 'Passwords require a password input' };
        }

        if (element.disabled) {
            return { valid: false, reason: 'Target is disabled' };
        }

        if (element.readOnly) {
            return { valid: false, reason: 'Target is read-only' };
        }

        // Visibility check
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            return { valid: false, reason: 'Target is not visible (zero size)' };
        }

        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') {
            return { valid: false, reason: 'Target is not visible (styled)' };
        }

        // Input type compatibility
        const inputType = (element.type || 'text').toLowerCase();
        const allowed = REF_VALID_INPUTS[secretRef];
        if (allowed && !allowed.has(inputType)) {
            return { valid: false, reason: `Input type "${inputType}" incompatible with secret ref "${secretRef}"` };
        }

        return { valid: true };
    }

    static _isContentEditableElement(element) {
        const tag = element?.tagName?.toLowerCase();
        if (['input', 'textarea', 'select', 'button', 'a'].includes(tag)) return false;
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

    /** Insert a value into a target element with proper DOM events. */
    static insertSecret(element, value, options = {}) {
        const isContentEditable = LocalSecretProvider._isContentEditableElement(element);

        if (isContentEditable) {
            // Rich-text editors do not expose a value property. Focus the
            // editor, replace its text node, and emit the same input/change
            // signals used by common React/Notion-style editors.
            try { element.focus(); } catch (_) { /* best effort */ }
            const view = element.ownerDocument?.defaultView || window;
            const InputCtor = view.InputEvent || view.Event;
            const inputInit = InputCtor === view.Event
                ? { bubbles: true }
                : { bubbles: true, inputType: 'insertText', data: String(value) };
            if (options.beforeinput !== false &&
                (typeof view.InputEvent === 'function' || InputCtor === view.Event)) {
                try { element.dispatchEvent(new InputCtor('beforeinput', { ...inputInit, cancelable: true })); } catch (_) { /* best effort */ }
            }
            element.textContent = String(value);
            element.dispatchEvent(new InputCtor('input', inputInit));
            const EventCtor = view.Event || Event;
            element.dispatchEvent(new EventCtor('change', { bubbles: true }));
            // Notion-style title editors commonly persist on blur. The action
            // layer normally keeps focus so a following safe keypress can be
            // delivered; callers may explicitly request the legacy blur.
            if (options.blur !== false) {
                try { element.blur(); } catch (_) { /* best effort */ }
            }
        } else {
            // Use the native setter for the element's actual realm/type.
            // Calling HTMLInputElement's setter on a textarea can throw
            // "Illegal invocation" in Chromium.
            const view = element.ownerDocument?.defaultView || window;
            const isTextarea = element.tagName?.toLowerCase() === 'textarea';
            const prototype = isTextarea
                ? view.HTMLTextAreaElement?.prototype
                : view.HTMLInputElement?.prototype;
            const nativeValueSetter = prototype
                ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set
                : null;
            const InputCtor = view.InputEvent || view.Event;
            const inputInit = InputCtor === view.Event
                ? { bubbles: true }
                : { bubbles: true, inputType: 'insertText', data: String(value) };
            if (options.beforeinput !== false) {
                try { element.dispatchEvent(new InputCtor('beforeinput', { ...inputInit, cancelable: true })); } catch (_) { /* best effort */ }
            }

            if (nativeValueSetter) {
                nativeValueSetter.call(element, value);
            } else {
                element.value = value;
            }

            // Dispatch standard input events so page JS reacts. Use the
            // element's own document Event constructor for cross-environment
            // compatibility.
            const EventCtor = view.Event || Event;
            element.dispatchEvent(new InputCtor('input', inputInit));
            element.dispatchEvent(new EventCtor('change', { bubbles: true }));
        }
    }
}
