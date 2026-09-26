
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

    _isSensitiveText(value) {
        return typeof value === 'string' && (
            /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value) ||
            /\b(?:\d[ -]*?){13,19}\b/.test(value) ||
            /\b\d{4}\s?\d{4}\s?\d{4}\b/.test(value) ||
            /\b[A-Z]{5}\d{4}[A-Z]\b/.test(value) ||
            /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/.test(value) ||
            /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(value) ||
            /\bghp_[A-Za-z0-9]{36}\b/.test(value) ||
            /\bsk-[A-Za-z0-9]{20,}\b/.test(value)
        );
    }

    _redactSensitiveMetadata(el, token) {
        for (const key of ['autocomplete', 'placeholder', 'ariaLabel', 'name', 'label', 'title', 'testId']) {
            if (this._isSensitiveText(el[key])) el[key] = token;
        }
        if (Array.isArray(el.options) && el.options.some(value => this._isSensitiveText(value))) {
            el.options = el.options.map(() => token);
        }
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
                this._redactSensitiveMetadata(el, token);
            } else if (bestToken) {
                el.text = bestToken;
                if (el.value) el.value = bestToken;

                // Semantic labels are useful to the planner, but a few sites
                // put a real value in an aria-label/name/placeholder. Replace
                // only metadata that actually looks sensitive; ordinary
                // labels such as "Email address" remain available.
                this._redactSensitiveMetadata(el, bestToken);
            }
        }
        return sanitized;
    }

    /** Replace common PII patterns in a non-DOM string such as a page URL. */
    redactText(value) {
        if (typeof value !== 'string' || !value) return '';
        const counters = {};
        const token = type => {
            counters[type] = (counters[type] || 0) + 1;
            return `[${type}_${counters[type]}]`;
        };
        const patterns = [
            ['AUTH_TOKEN', /\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,})\b/g],
            ['EMAIL', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
            ['CREDIT_CARD', /\b(?:\d[ -]*?){13,19}\b/g],
            ['AADHAAR', /\b\d{4}\s?\d{4}\s?\d{4}\b/g],
            ['PHONE', /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/g],
            ['PAN', /\b[A-Z]{5}\d{4}[A-Z]\b/g]
        ];
        let result = value;
        for (const [type, pattern] of patterns) {
            result = result.replace(pattern, () => token(type));
        }
        return result;
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
