
export class PIIDetector {
    constructor() {
        this.regexes = {
            EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
            PHONE: /\+?\d{1,3}[-.\s]?\(?\d{1,4}?\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g, // Basic, avoid excessive FPs
            CREDIT_CARD: /\b(?:\d[ -]*?){13,16}\b/g,
            AUTH_TOKEN: /\b(?:ey[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*|ghp_[a-zA-Z0-9]{36})\b/g, // JWT or Github tokens
            PERSON: /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, // Overly simplistic, mainly rely on DOM autocomplete
            ADDRESS: /\d{1,5}\s\w.\s(\b\w*\b\s){1,2}\w*\./g // Simplistic, mainly rely on DOM
        };
    }

    // Helper: Find matches and return raw detections without storing actual value
    extractRegex(text, bbox, source) {
        const detections = [];
        for (const [type, regex] of Object.entries(this.regexes)) {
            // Reset regex state
            regex.lastIndex = 0;
            let match;
            let safetyCount = 0;
            while ((match = regex.exec(text)) !== null && safetyCount < 50) {
                // To avoid FP, strict checks can be added here
                // We only store metadata
                detections.push({
                    type,
                    bbox,
                    confidence: 0.7, // Regex alone is medium confidence
                    sources: [source]
                });
                safetyCount++;
            }
        }
        return detections;
    }

    detectDOM(element) {
        const detections = [];
        const bbox = element.bbox;

        // 1. Password
        if (element.inputType === 'password') {
            detections.push({ type: 'PASSWORD', bbox, confidence: 1.0, sources: ['DOM'] });
        }

        // 2. Autocomplete hints
        const htmlLower = (element.tag + ' ' + element.id + ' ' + element.role).toLowerCase();
        // Assume 'autocomplete' might be extracted in future, check role/id as proxy for now
        if (htmlLower.includes('email')) {
            detections.push({ type: 'EMAIL', bbox, confidence: 0.9, sources: ['DOM'] });
        }
        if (htmlLower.includes('cc-number') || htmlLower.includes('card')) {
            detections.push({ type: 'CREDIT_CARD', bbox, confidence: 0.9, sources: ['DOM'] });
        }
        if (htmlLower.includes('name') && !htmlLower.includes('username')) {
            detections.push({ type: 'PERSON', bbox, confidence: 0.8, sources: ['DOM'] });
        }
        if (htmlLower.includes('address')) {
            detections.push({ type: 'ADDRESS', bbox, confidence: 0.8, sources: ['DOM'] });
        }
        if (htmlLower.includes('avatar') || htmlLower.includes('profile-pic')) {
            detections.push({ type: 'FACE', bbox, confidence: 0.8, sources: ['DOM'] });
        }

        // 3. Extract from DOM text via Regex
        if (element.text) {
            detections.push(...this.extractRegex(element.text, bbox, 'DOM_REGEX'));
        }

        return detections;
    }

    detectOCR(ocrResult) {
        return this.extractRegex(ocrResult.text, ocrResult.bbox, 'OCR');
    }

    detectAll(domElements, ocrResults) {
        let allDetections = [];
        
        for (const el of domElements) {
            allDetections.push(...this.detectDOM(el));
        }

        for (const ocr of ocrResults) {
            allDetections.push(...this.detectOCR(ocr));
        }

        return allDetections;
    }
}
