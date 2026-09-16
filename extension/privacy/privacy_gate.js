
export class PrivacyGate {
    constructor() {
        this.KNOWN_TYPES = new Set([
            'EMAIL', 'PHONE', 'PERSON', 'ADDRESS', 
            'CREDIT_CARD', 'PASSWORD', 'AUTH_TOKEN', 'FACE'
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
            
            // Catch edge case: password type leaking value
            if (san.inputType === 'password') {
                if (san.text !== '[PASSWORD_1]' && !san.text.startsWith('[PASSWORD')) {
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
            // Check center pixel of the bbox to ensure it's black (0,0,0)
            const cx = Math.floor((plan.bbox.x + plan.bbox.width / 2) * scaleX);
            const cy = Math.floor((plan.bbox.y + plan.bbox.height / 2) * scaleY);

            // Bounds check
            if (cx >= 0 && cx < redactedCanvas.width && cy >= 0 && cy < redactedCanvas.height) {
                const idx = (cy * redactedCanvas.width + cx) * 4;
                const r = imgData[idx];
                const g = imgData[idx+1];
                const b = imgData[idx+2];
                
                if (r !== 0 || g !== 0 || b !== 0) {
                    throw new Error(`Incomplete visual redaction at (${cx}, ${cy}) for ${plan.type}`);
                }
            } else {
                throw new Error("Coordinate mismatch, out of bounds");
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
