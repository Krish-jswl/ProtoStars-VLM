export class PIIDetector {
    constructor() {
        this.regexes = {
            EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
            PHONE: /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/g,
            CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/g,
            AUTH_TOKEN: /\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]*|ghp_[a-zA-Z0-9]{36}|sk-[a-zA-Z0-9]{20,})\b/g,
            AADHAAR: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
            PAN: /\b[A-Z]{5}\d{4}[A-Z]\b/g
        };
    }

    /** Luhn check for credit card validation */
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

    /** Verhoeff checksum for Aadhaar validation */
    _verhoeffCheck(numStr) {
        const digits = numStr.replace(/\D/g, '');
        if (digits.length !== 12) return false;
        const d = [
            [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],
            [2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],
            [4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
            [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],
            [8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]
        ];
        const p = [
            [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],
            [5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
            [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
            [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]
        ];
        const inv = [0,4,3,2,1,5,6,7,8,9];
        let c = 0;
        const arr = digits.split('').reverse().map(Number);
        for (let i = 0; i < arr.length; i++) {
            c = d[c][p[i % 8][arr[i]]];
        }
        return c === 0;
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
                if (type === 'AADHAAR') {
                    if (!this._verhoeffCheck(match[0])) continue;
                }
                if (type === 'PAN') {
                    // 4th char must be C/P/H/F/A/T/B/L/J/G (entity type)
                    const fourthChar = match[0][3];
                    if (!'CPHFATBLJG'.includes(fourthChar)) continue;
                }
                detections.push({ type, bbox, confidence: 0.75, sources: [source] });
            }
        }
        return detections;
    }

    _hasUsableBbox(bbox) {
        return !!(bbox && bbox.width > 0 && bbox.height > 0);
    }

    _looksLikePasswordField(element) {
        const ac = (element.autocomplete || '').toLowerCase();
        if (element.inputType === 'password') return true;
        if (ac === 'current-password' || ac === 'new-password') return true;
        const idLower = (element.id || '').toLowerCase();
        if (/(?:^|[-_])(?:password|passwd|pwd)(?:$|[-_])/i.test(idLower) ||
            idLower === 'password' || idLower.includes('password') ||
            idLower.includes('passwd') || idLower.endsWith('pwd') || idLower.includes('-pwd') || idLower.includes('_pwd')) {
            return true;
        }
        return false;
    }

    detectDOM(element) {
        const detections = [];
        const bbox = element.bbox;
        const isInput = element.tag === 'input' || element.tag === 'textarea' || element.tag === 'select';

        // 1. Password — type=password, autocomplete, or password-like id (incl. "show password" text fields)
        if (isInput && this._looksLikePasswordField(element) && this._hasUsableBbox(bbox)) {
            detections.push({ type: 'PASSWORD', bbox, confidence: 1.0, sources: ['DOM'] });
        }

        // 2. Autocomplete attribute (inputs only, skip empty)
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

        // 3. ID heuristics — ONLY for actual input elements
        if (isInput) {
            const idLower = (element.id || '').toLowerCase();
            if (idLower.includes('email') && !ac) {
                detections.push({ type: 'EMAIL', bbox, confidence: 0.8, sources: ['DOM'] });
            }
            if ((idLower.includes('card') || idLower.includes('cc-')) && !ac) {
                detections.push({ type: 'CREDIT_CARD', bbox, confidence: 0.8, sources: ['DOM'] });
            }
            if ((idLower.includes('aadhaar') || idLower.includes('aadhar') || idLower.includes('uid')) && !ac) {
                detections.push({ type: 'AADHAAR', bbox, confidence: 0.8, sources: ['DOM'] });
            }
            if (idLower.includes('pan') && !ac) {
                detections.push({ type: 'PAN', bbox, confidence: 0.8, sources: ['DOM'] });
            }
            if (idLower.includes('address') && !ac) {
                detections.push({ type: 'ADDRESS', bbox, confidence: 0.8, sources: ['DOM'] });
            }
            if (idLower.includes('avatar') || idLower.includes('profile-pic')) {
                detections.push({ type: 'FACE', bbox, confidence: 0.8, sources: ['DOM'] });
            }
        }

        // 4. Regex over element text — skip buttons, links, headings, labels
        //    Also skip password-like fields so raw secrets are never regex-tokenized as EMAIL/etc.
        const skipTagsForRegex = new Set(['button', 'a', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
        if (element.text && !skipTagsForRegex.has(element.tag) &&
            !(isInput && this._looksLikePasswordField(element))) {
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
