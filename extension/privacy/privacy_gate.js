
export class PrivacyGate {
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
