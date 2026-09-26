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

    _looksLikePersonName(text) {
        if (typeof text !== 'string') return false;
        const value = text.trim();
        if (value.length < 3 || value.length > 80) return false;
        const stopWords = new Set([
            'save', 'button', 'submit', 'application', 'full', 'name', 'email',
            'inbox', 'compose', 'subject', 'message', 'send', 'hello', 'world',
            'software', 'engineer', 'customer', 'account', 'login', 'sign', 'out',
            'whatsapp', 'web', 'google', 'meet', 'profile', 'contact', 'conversation',
            'chat', 'search', 'settings', 'privacy', 'terms', 'community', 'status',
            'text', 'today', 'yesterday', 'online', 'away', 'thanks', 'thank',
            'you', 'please', 'yes', 'no', 'sure', 'hi', 'hey', 'good', 'morning',
            'night', 'see', 'later', 'welcome'
        ]);
        const words = value.split(/\s+/);
        if (words.length < 2 || words.length > 4) return false;
        if (words.some(word => stopWords.has(word.toLowerCase().replace(/[^a-z]/g, '')))) return false;
        return words.every(word => /^[A-Z][a-z'-]+$/.test(word));
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
                // Aadhaar-shaped values are redacted conservatively. A failed
                // checksum should not make a real identifier leave the page.
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

        // 2. Input semantics/autocomplete (empty login fields still count)
        const inputType = String(element.inputType || '').toLowerCase();
        if (isInput && inputType === 'email' && this._hasUsableBbox(bbox)) {
            detections.push({ type: 'EMAIL', bbox, confidence: 0.95, sources: ['DOM_INPUT_TYPE'] });
        }
        if (isInput && inputType === 'tel' && this._hasUsableBbox(bbox)) {
            detections.push({ type: 'PHONE', bbox, confidence: 0.9, sources: ['DOM_INPUT_TYPE'] });
        }
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
        if (isInput || element.inputType === 'contenteditable') {
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
            const semantic = [element.id, element.name, element.placeholder, element.ariaLabel, element.label]
                .filter(Boolean).join(' ').toLowerCase();
            if (element.text && /(^|[-_ ])(full[-_ ]?)?name|given[-_ ]?name|family[-_ ]?name/.test(semantic)) {
                detections.push({ type: 'PERSON', bbox, confidence: 0.85, sources: ['DOM'] });
            }
            if (idLower.includes('avatar') || idLower.includes('profile-pic')) {
                detections.push({ type: 'FACE', bbox, confidence: 0.8, sources: ['DOM'] });
            }
        }

        // A small, conservative name heuristic covers common profile/inbox
        // markup (including profile names rendered in generic text wrappers)
        // without treating ordinary controls as people.
        const textTag = ['strong', 'b', 'address', 'span', 'div', 'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']
            .includes(element.tag);
        const identity = [element.id, element.name, element.ariaLabel, element.label, element.placeholder]
            .filter(Boolean).join(' ').toLowerCase();
        const profileHint = /profile|avatar|contact|account|display|full[-_ ]?name/.test(identity);
        const role = String(element.role || '').toLowerCase();
        if (['img', 'image'].includes(element.tag) || role === 'img') {
            if (/avatar|profile|face|photo|pfp|profile[-_ ]?pic/.test(identity)) {
                detections.push({
                    type: 'FACE',
                    bbox,
                    confidence: 0.8,
                    sources: ['DOM_AVATAR']
                });
            }
        }
        const metadataName = [element.ariaLabel, element.label, element.placeholder, element.name]
            .some(value => this._looksLikePersonName(value));
        if ((textTag && this._looksLikePersonName(element.text)) || (profileHint && metadataName)) {
            detections.push({
                type: 'PERSON',
                bbox,
                confidence: profileHint || ['strong', 'b', 'address'].includes(element.tag) ? 0.7 : 0.55,
                sources: ['DOM_NAME_HEURISTIC']
            });
        }

        // 4. Regex over all visible text. Buttons, links, and labels can
        // contain real account data too, so excluding them would create a
        // privacy bypass. Password-like fields are excluded because their
        // value is handled by the dedicated PASSWORD path.
        if (element.text && !(isInput && this._looksLikePasswordField(element))) {
            detections.push(...this.extractRegex(element.text, bbox, 'DOM_REGEX'));
        }

        // Labels and attributes occasionally contain an actual value (for
        // example, a pre-filled field copied into aria-label). Scan them too,
        // but never retain the matched string in the detection object.
        for (const metadata of [element.autocomplete, element.placeholder, element.ariaLabel, element.name, element.label]) {
            if (metadata && !this._looksLikePasswordField(element)) {
                detections.push(...this.extractRegex(metadata, bbox, 'DOM_METADATA'));
            }
        }
        for (const option of element.options || []) {
            if (option && !this._looksLikePasswordField(element)) {
                detections.push(...this.extractRegex(option, bbox, 'DOM_METADATA'));
            }
        }

        return detections;
    }

    detectOCR(ocrResult) {
        const detections = this.extractRegex(ocrResult.text, ocrResult.bbox, 'OCR');
        if (this._looksLikePersonName(ocrResult.text)) {
            detections.push({
                type: 'PERSON',
                bbox: ocrResult.bbox,
                confidence: 0.55,
                sources: ['OCR_NAME_HEURISTIC']
            });
        }
        return detections;
    }

    _isProfileImageCandidate(node) {
        if (!node || node.visible === false) return false;
        const tag = String(node.tag || '').toLowerCase();
        const role = String(node.role || '').toLowerCase();
        if (!['img', 'image'].includes(tag) && role !== 'img') return false;
        const identity = [node.id, node.name, node.ariaLabel, node.label, node.placeholder]
            .filter(Boolean).join(' ').toLowerCase();
        if (/avatar|profile|face|photo|pfp|profile[-_ ]?pic/.test(identity)) return true;
        const width = Number(node.bbox?.width) || 0;
        const height = Number(node.bbox?.height) || 0;
        const ratio = width && height ? width / height : 0;
        return width >= 24 && width <= 180 && height >= 24 && height <= 180 &&
            ratio >= 0.72 && ratio <= 1.38;
    }

    _isShortNameCandidate(node) {
        const text = String(node?.text || '').trim();
        if (!text || text.length > 80 || /\d[@+._-]|\d{3,}/.test(text)) return false;
        if (this._looksLikePersonName(text)) return true;
        const words = text.split(/\s+/);
        if (words.length !== 1) return false;
        const stopWords = new Set([
            'online', 'away', 'active', 'settings', 'profile', 'contact', 'message',
            'chat', 'search', 'status', 'today', 'yesterday', 'privacy', 'help'
        ]);
        const word = words[0].toLowerCase().replace(/[^a-z]/g, '');
        return /^[A-Z][a-z'-]{2,}$/.test(words[0]) && !stopWords.has(word);
    }

    _boxesNear(a, b) {
        const ax = Number(a?.x) || 0;
        const ay = Number(a?.y) || 0;
        const aw = Number(a?.width) || 0;
        const ah = Number(a?.height) || 0;
        const bx = Number(b?.x) || 0;
        const by = Number(b?.y) || 0;
        const bw = Number(b?.width) || 0;
        const bh = Number(b?.height) || 0;
        const aCenterX = ax + aw / 2;
        const bCenterX = bx + bw / 2;
        const aCenterY = ay + ah / 2;
        const bCenterY = by + bh / 2;
        const horizontalGap = Math.max(0, Math.max(ax, bx) - Math.min(ax + aw, bx + bw));
        const verticalGap = Math.max(0, Math.max(ay, by) - Math.min(ay + ah, by + bh));
        return horizontalGap <= Math.max(180, aw * 3) &&
            verticalGap <= Math.max(80, ah * 2) &&
            Math.abs(aCenterY - bCenterY) <= Math.max(80, ah * 2) &&
            Math.abs(aCenterX - bCenterX) <= 240;
    }

    _hasOverlappingDetection(detections, type, bbox) {
        return detections.some(det => det.type === type && this._boxesNear(det.bbox, bbox));
    }

    detectProfileContexts(domElements, detections) {
        const elements = Array.isArray(domElements) ? domElements : [];
        const images = elements.filter(node => this._isProfileImageCandidate(node));
        if (!images.length) return detections;
        const textNodes = elements.filter(node => node?.text && this._isShortNameCandidate(node));
        for (const image of images) {
            if (!this._hasOverlappingDetection(detections, 'FACE', image.bbox)) {
                detections.push({
                    type: 'FACE',
                    bbox: { ...image.bbox },
                    confidence: 0.65,
                    sources: ['PROFILE_CONTEXT']
                });
            }
            for (const textNode of textNodes) {
                if (!this._boxesNear(image.bbox, textNode.bbox)) continue;
                if (!this._hasOverlappingDetection(detections, 'PERSON', textNode.bbox)) {
                    detections.push({
                        type: 'PERSON',
                        bbox: { ...textNode.bbox },
                        confidence: 0.65,
                        sources: ['PROFILE_CONTEXT']
                    });
                }
            }
        }
        return detections;
    }

    detectAll(domElements, ocrResults) {
        let allDetections = [];
        for (const el of domElements) {
            allDetections.push(...this.detectDOM(el));
        }
        for (const ocr of ocrResults) {
            allDetections.push(...this.detectOCR(ocr));
        }
        return this.detectProfileContexts(domElements, allDetections);
    }
}
