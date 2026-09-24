
export class ActionExecutor {
    constructor(config) {
        this.config = config;
    }

    validateTarget(element) {
        if (!element) return { valid: false, reason: "Element not found" };
        
        const rect = element.getBoundingClientRect();
        if (this.config.actionValidation.requireVisible) {
            if (rect.width === 0 || rect.height === 0) return { valid: false, reason: "Element not visible (zero size)" };
            
            const style = window.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden') return { valid: false, reason: "Element not visible (styled)" };
        }
        if (element.disabled) return { valid: false, reason: "Element disabled" };
        
        return { valid: true };
    }

    /** Build a safe CSS selector from an element id (or pass through a full selector). */
    static selectorForTarget(target) {
        if (!target || typeof target !== 'string') return null;
        const trimmed = target.trim();
        if (!trimmed) return null;
        // Already a selector (id, class, attr, etc.)
        if (trimmed.startsWith('#') || trimmed.startsWith('.') || trimmed.startsWith('[') ||
            trimmed.includes(' ') || trimmed.includes('>')) {
            return trimmed;
        }
        const escape = (typeof CSS !== 'undefined' && CSS.escape)
            ? CSS.escape
            : (s) => s.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
        return `#${escape(trimmed)}`;
    }

    execute(actionType, targetSelector, args = {}) {
        if (!this.config.actionValidation.allowedActions.includes(actionType)) {
            return { success: false, error: `Action ${actionType} not allowed` };
        }

        let element;
        try {
            // Page-level scroll may target document/window/body
            if (actionType === 'scroll' && (!targetSelector || /^(document|window|body|html)$/i.test(targetSelector.replace(/^#/, '')))) {
                window.scrollBy({
                    top: args.y || 0,
                    left: args.x || 0,
                    behavior: 'smooth'
                });
                return { success: true };
            }
            element = document.querySelector(targetSelector);
        } catch(e) {
            return { success: false, error: `Invalid selector` };
        }

        const validation = this.validateTarget(element);
        if (!validation.valid) {
            return { success: false, error: validation.reason };
        }

        try {
            switch(actionType) {
                case 'click':
                    element.click();
                    break;
                case 'focus':
                    element.focus();
                    break;
                case 'scroll':
                    element.scrollBy({
                        top: args.y || 0,
                        left: args.x || 0,
                        behavior: 'smooth'
                    });
                    break;
                case 'select': {
                    const tag = element.tagName?.toLowerCase();
                    if (tag !== 'select') {
                        return { success: false, error: 'select action requires a <select> element' };
                    }
                    const wanted = args.value ?? args.text;
                    if (wanted == null || wanted === '') {
                        return { success: false, error: 'select requires args.value or args.text' };
                    }
                    const wantedStr = String(wanted);
                    let matched = false;
                    for (const opt of element.options) {
                        if (opt.value === wantedStr || opt.text === wantedStr || opt.label === wantedStr) {
                            element.value = opt.value;
                            matched = true;
                            break;
                        }
                    }
                    if (!matched) {
                        return { success: false, error: 'No matching option' };
                    }
                    const EventCtor = element.ownerDocument?.defaultView?.Event || Event;
                    element.dispatchEvent(new EventCtor('input', { bubbles: true }));
                    element.dispatchEvent(new EventCtor('change', { bubbles: true }));
                    break;
                }
                default:
                    return { success: false, error: `Unknown action` };
            }
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
}
