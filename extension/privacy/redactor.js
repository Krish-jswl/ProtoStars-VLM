
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

    sanitizeDOM(rawDomElements, plannedRedactions) {
        // Deep copy to avoid mutating raw context
        const sanitized = JSON.parse(JSON.stringify(rawDomElements));

        for (const el of sanitized) {
            // Find if this element overlaps with any PII redaction plan
            let highestOverlap = 0;
            let bestToken = null;

            for (const plan of plannedRedactions) {
                const overlap = this.calculateOverlap(el.bbox, plan.bbox);
                if (overlap > highestOverlap) {
                    highestOverlap = overlap;
                    bestToken = plan.token;
                }
            }

            // If overlap exists or element is explicitly a password
            if (bestToken || el.inputType === 'password') {
                el.text = bestToken || '[PASSWORD_1]';
                // Remove sensitive attributes
                if (el.value) el.value = bestToken || '[PASSWORD_1]';
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
