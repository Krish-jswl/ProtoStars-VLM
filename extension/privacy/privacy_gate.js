
export class PrivacyGate {
    _containsSensitiveText(value) {
        return typeof value === 'string' && (
            /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value) ||
            /\b(?:\d[ -]*?){13,19}\b/.test(value) ||
            /\b\d{4}\s?\d{4}\s?\d{4}\b/.test(value) ||
            /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/.test(value) ||
            /\b(?:ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}|ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/.test(value)
        );
    }

    constructor() {
        this.KNOWN_TYPES = new Set([
            'EMAIL', 'PHONE', 'PERSON', 'ADDRESS', 
            'CREDIT_CARD', 'PASSWORD', 'AUTH_TOKEN', 'FACE',
            'AADHAAR', 'PAN'
        ]);
    }

    verifyDOM(rawDom, sanitizedDom, plannedRedactions) {
        // Check 1: Ensure no sanitized text matches original sensitive text
        for (let i = 0; i < rawDom.length; i++) {
            const raw = rawDom[i];
            const san = sanitizedDom[i];
            
            // If it was supposed to be redacted, ensure raw text is gone
            if (san.text && san.text.startsWith('[') && san.text.endsWith(']')) {
                if (raw.text && raw.text.length > 3 && san.text === raw.text) {
                    throw new Error(`Sanitized text matches raw text for element ${raw.id || raw.tag}`);
                }
            }
            if (this._containsSensitiveText(raw.text) && san.text === raw.text) {
                throw new Error(`Sensitive text remained in element ${raw.id || raw.tag}`);
            }
            
            // Ensure password fields (incl. show-password text inputs) are always masked
            const ac = (san.autocomplete || '').toLowerCase();
            const idLower = (san.id || '').toLowerCase();
            const isPasswordField = san.inputType === 'password' ||
                ac === 'current-password' || ac === 'new-password' ||
                idLower.includes('password') || idLower.includes('passwd') ||
                idLower.includes('-pwd') || idLower.includes('_pwd') || idLower.endsWith('pwd');
            if (isPasswordField) {
                // The sanitized text must be a placeholder that starts with [PASSWORD
                if (!san.text || !san.text.startsWith('[PASSWORD')) {
                    throw new Error("Password field not properly sanitized");
                }
            }

            // Metadata is part of the planner payload too. Do not allow a raw
            // value hidden in a label/attribute to bypass the DOM redaction.
            for (const key of ['autocomplete', 'placeholder', 'ariaLabel', 'name', 'label']) {
                const value = san[key];
                if (this._containsSensitiveText(raw[key]) && value === raw[key]) {
                    throw new Error(`Sensitive value remained in ${key}`);
                }
                if (typeof value === 'string' && (
                    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value) ||
                    /\b(?:\d[ -]*?){13,19}\b/.test(value) ||
                    /\b\d{4}\s?\d{4}\s?\d{4}\b/.test(value) ||
                    /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/.test(value) ||
                    /\b(?:ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}|ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/.test(value)
                )) {
                    throw new Error(`Sensitive value remained in ${key}`);
                }
            }
            if (Array.isArray(san.options)) {
                const rawOptions = Array.isArray(raw.options) ? raw.options : [];
                for (let index = 0; index < san.options.length; index++) {
                    const option = san.options[index];
                    if (this._containsSensitiveText(rawOptions[index]) && option === rawOptions[index]) {
                        throw new Error('Sensitive value remained in select options');
                    }
                    if (typeof option === 'string' && (
                        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(option) ||
                        /\b(?:\d[ -]*?){13,19}\b/.test(option) ||
                        /\b\d{4}\s?\d{4}\s?\d{4}\b/.test(option) ||
                        /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/.test(option) ||
                        /\b(?:ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}|ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/.test(option)
                    )) {
                        throw new Error('Sensitive value remained in select options');
                    }
                }
            }
        }
        return true;
    }

    verifyImage(redactedCanvas, plannedRedactions, scaleX = 1.0, scaleY = 1.0) {
        if (!redactedCanvas) throw new Error("Missing redacted canvas");
        
        const ctx = redactedCanvas.getContext('2d');
        const imgData = ctx.getImageData(0, 0, redactedCanvas.width, redactedCanvas.height).data;

        for (const plan of plannedRedactions) {
            const { x, y, width, height } = plan.bbox;

            // Skip zero-area bboxes (e.g. hidden/off-screen inputs)
            if (!width || !height) continue;

            // Check center pixel of the bbox to ensure it's black (0,0,0)
            const cx = Math.floor((x + width / 2) * scaleX);
            const cy = Math.floor((y + height / 2) * scaleY);

            // Skip elements that are outside the captured image area
            // (e.g. elements scrolled off-screen or in a different frame)
            if (cx < 0 || cx >= redactedCanvas.width || cy < 0 || cy >= redactedCanvas.height) {
                continue;
            }

            const idx = (cy * redactedCanvas.width + cx) * 4;
            const r = imgData[idx];
            const g = imgData[idx+1];
            const b = imgData[idx+2];

            if (r !== 0 || g !== 0 || b !== 0) {
                throw new Error(`Incomplete visual redaction at (${cx}, ${cy}) for ${plan.type}`);
            }
        }
        return true;
    }

    verify(rawContext, sanitizedContext, plannedRedactions) {
        const violations = [];

        try {
            // 1. Unknown Type Check
            for (const plan of plannedRedactions) {
                if (!this.KNOWN_TYPES.has(plan.type)) {
                    throw new Error(`Unknown/unhandled sensitive detection: ${plan.type}`);
                }
            }

            // 2. DOM Verification
            this.verifyDOM(rawContext.dom, sanitizedContext.dom, plannedRedactions);

            // 3. Image Verification
            this.verifyImage(sanitizedContext.image, plannedRedactions, rawContext.scaleX, rawContext.scaleY);

        } catch (e) {
            violations.push(e.message);
        }

        return {
            allowed: violations.length === 0,
            violations
        };
    }
}
