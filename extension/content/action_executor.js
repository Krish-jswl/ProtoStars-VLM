
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

    execute(actionType, targetSelector, args = {}) {
        if (!this.config.actionValidation.allowedActions.includes(actionType)) {
            return { success: false, error: `Action ${actionType} not allowed` };
        }

        let element;
        try {
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
                default:
                    return { success: false, error: `Unknown action` };
            }
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
}
