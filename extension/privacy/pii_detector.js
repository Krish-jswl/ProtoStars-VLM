export class PIIDetector {
    constructor() {
        this.regexes = {
            EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
            PHONE: /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/g,
            CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/g,
            AUTH_TOKEN: /\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]*|ghp_[a-zA-Z0-9]{36}|sk-[a-zA-Z0-9]{20,})\b/g
        };
    }

    /** Luhn check for credit card validation to reduce FP */
    _luhnCheck(numStr) {
        const digits = numStr.replace(/\D/g, '');
        if (digits.length < 13 || digits.length > 19) return false;
        let sum = 0;
        let alt = false;
        for (let i = digits.length - 1; i >= 0; i--) {
            let n = parseInt(digits[i], 10);
            if (alt) { n *= 2; if (n > 9) n -= 9; }
            sum += n;
            alt = !alt;
        }
        return sum % 10 === 0;
    }

    extractRegex(text, bbox, source) {
        const detections = [];
        for (const [type, regex] of Object.entries(this.regexes)) {
            regex.lastIndex = 0;
            let match;
            let safetyCount = 0;
            while ((match = regex.exec(text)) !== null && safetyCount < 50) {
                safetyCount++;
                if (type === 'CREDIT_CARD') {
                    if (!this._luhnCheck(match[0])) continue;
                }
                if (type === 'PHONE') {
                    const digitCount = match[0].replace(/\D/g, '').length;
                    if (digitCount < 7) continue;
                }
                detections.push({ type, bbox, confidence: 0.75, sources: [source] });
            }
        }
        return detections;
    }

    detectDOM(element) {
        const detections = [];
        const bbox = element.bbox;
        const isInput = element.tag === 'input' || element.tag === 'textarea' || element.tag === 'select';

        // 1. Password (DOM semantics only — inputs only, skip empty hidden fields)
        if (element.inputType === 'password' && element.text) {
            detections.push({ type: 'PASSWORD', bbox, confidence: 1.0, sources: ['DOM'] });
        }

        // 2. Autocomplete attribute (strongest DOM signal — inputs only)
        const ac = (element.autocomplete || '').toLowerCase();
        if ((ac === 'email' || ac === 'username') && element.text) {
            detections.push({ type: 'EMAIL', bbox, confidence: 0.95, sources: ['DOM'] });
        }
        if (ac === 'tel' || ac === 'tel-national') {
            detections.push({ type: 'PHONE', bbox, confidence: 0.95, sources: ['DOM'] });
        }
        if (ac === 'cc-number' || ac === 'cc-csc' || ac === 'cc-exp') {
            detections.push({ type: 'CREDIT_CARD', bbox, confidence: 0.95, sources: ['DOM'] });
        }
        if (ac === 'name' || ac === 'given-name' || ac === 'family-name') {
            detections.push({ type: 'PERSON', bbox, confidence: 0.9, sources: ['DOM'] });
        }
        if (ac === 'street-address' || ac === 'address-line1' || ac === 'postal-code') {
            detections.push({ type: 'ADDRESS', bbox, confidence: 0.9, sources: ['DOM'] });
        }

        // 3. ID/role heuristics — ONLY for actual input elements to avoid false positives on labels/divs
        if (isInput) {
            const idLower = (element.id || '').toLowerCase();
            if (idLower.includes('email') && !ac) {
                detections.push({ type: 'EMAIL', bbox, confidence: 0.8, sources: ['DOM'] });
            }
            if ((idLower.includes('card') || idLower.includes('cc-')) && !ac) {
                detections.push({ type: 'CREDIT_CARD', bbox, confidence: 0.8, sources: ['DOM'] });
            }
            if (idLower.includes('address') && !ac) {
                detections.push({ type: 'ADDRESS', bbox, confidence: 0.8, sources: ['DOM'] });
            }
            if (idLower.includes('avatar') || idLower.includes('profile-pic')) {
                detections.push({ type: 'FACE', bbox, confidence: 0.8, sources: ['DOM'] });
            }
        }

        // 4. Regex over element text — but ONLY if element is an input (value) or non-interactive text
        //    Skip for buttons, links, and labels to avoid false positives on helper text
        const skipTagsForRegex = new Set(['button', 'a', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
        if (element.text && !skipTagsForRegex.has(element.tag)) {
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
