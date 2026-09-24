
export class Redactor {
    constructor() {
        this.REDACTION_COLOR = '#000000';
    }

    calculateOverlap(box1, box2) {
        if (!box1 || !box2) return 0;
        const left = Math.max(box1.x, box2.x);
        const right = Math.min(box1.x + box1.width, box2.x + box2.width);
        const top = Math.max(box1.y, box2.y);
        const bottom = Math.min(box1.y + box1.height, box2.y + box2.height);

        if (left < right && top < bottom) {
            return (right - left) * (bottom - top);
        }
        return 0;
    }

    planRedaction(piiDetections) {
        const counters = {};
        const planned = [];

        for (const det of piiDetections) {
            if (!counters[det.type]) counters[det.type] = 1;
            const token = `[${det.type}_${counters[det.type]}]`;
            counters[det.type]++;

            planned.push({
                ...det,
                token
            });
        }
        return planned;
    }

    _isPasswordElement(el) {
        if (el.inputType === 'password') return true;
        const ac = (el.autocomplete || '').toLowerCase();
        if (ac === 'current-password' || ac === 'new-password') return true;
        const idLower = (el.id || '').toLowerCase();
        return idLower.includes('password') || idLower.includes('passwd') ||
            idLower.includes('-pwd') || idLower.includes('_pwd') || idLower.endsWith('pwd');
    }

    sanitizeDOM(rawDomElements, plannedRedactions) {
        // Deep copy to avoid mutating raw context
        const sanitized = JSON.parse(JSON.stringify(rawDomElements));

        for (const el of sanitized) {
            const isPassword = this._isPasswordElement(el);

            // Prefer a PASSWORD plan token for password fields so the gate check passes
            // even when another PII type overlaps the same bbox.
            let bestToken = null;
            let highestOverlap = 0;
            let passwordToken = null;

            for (const plan of plannedRedactions) {
                const overlap = this.calculateOverlap(el.bbox, plan.bbox);
                if (overlap > highestOverlap) {
                    highestOverlap = overlap;
                    bestToken = plan.token;
                }
                if (plan.type === 'PASSWORD' && overlap > 0) {
                    passwordToken = plan.token;
                }
            }

            if (isPassword) {
                const token = passwordToken || '[PASSWORD_1]';
                el.text = token;
                if (el.value !== undefined) el.value = token;
            } else if (bestToken) {
                el.text = bestToken;
                if (el.value) el.value = bestToken;
            }
        }
        return sanitized;
    }

    async redactImage(rawCanvas, plannedRedactions, scaleX = 1.0, scaleY = 1.0) {
        // Create an offscreen canvas for the redacted image
        // In browser extension content script/tests, we use standard Canvas
        const redactedCanvas = document.createElement('canvas');
        redactedCanvas.width = rawCanvas.width;
        redactedCanvas.height = rawCanvas.height;
        const ctx = redactedCanvas.getContext('2d');
        
        ctx.drawImage(rawCanvas, 0, 0);
        ctx.fillStyle = this.REDACTION_COLOR;

        for (const plan of plannedRedactions) {
            const { x, y, width, height } = plan.bbox;
            // Apply coordinate scaling if the image was resized during preprocessing
            ctx.fillRect(
                Math.floor(x * scaleX), 
                Math.floor(y * scaleY), 
                Math.ceil(width * scaleX), 
                Math.ceil(height * scaleY)
            );
        }

        return redactedCanvas;
    }
}
