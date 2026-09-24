
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
        if (tag !== 'input' && tag !== 'textarea') {
            return { valid: false, reason: 'Target must be input or textarea' };
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

    /** Insert a secret into a target element with proper DOM events. */
    static insertSecret(element, value) {
        // Use native input setter to trigger framework reactivity
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        )?.set;

        if (nativeInputValueSetter) {
            nativeInputValueSetter.call(element, value);
        } else {
            element.value = value;
        }

        // Dispatch standard input events so page JS reacts
        // Use the element's own document Event constructor for cross-environment compat
        const EventCtor = element.ownerDocument?.defaultView?.Event || Event;
        element.dispatchEvent(new EventCtor('input', { bubbles: true }));
        element.dispatchEvent(new EventCtor('change', { bubbles: true }));
    }
}
