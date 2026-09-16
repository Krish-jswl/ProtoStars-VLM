
export class DOMAnalyzer {
    isVisible(element) {
        if (!element || element.nodeType !== 1) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        if (rect.width === 0 || rect.height === 0) return false;
        return true;
    }

    analyzeElement(element) {
        const rect = element.getBoundingClientRect();
        return {
            id: element.id || '',
            role: element.getAttribute('role') || '',
            tag: element.tagName.toLowerCase(),
            text: (element.innerText || element.textContent || '').substring(0, 200).trim() || '',
            bbox: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
            },
            visible: this.isVisible(element),
            enabled: !element.disabled,
            inputType: element.type || '',
            autocomplete: element.getAttribute('autocomplete') || ''
        };
    }

    analyzeDOM() {
        const results = [];
        const seen = new Set();

        // 1. Interactive elements (original Phase 1 behavior)
        const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
        for (const el of document.querySelectorAll(interactiveSelectors)) {
            results.push(this.analyzeElement(el));
            seen.add(el);
        }

        // 2. Visible text-bearing elements (NEW for Phase 8B)
        // Scan block-level and inline text containers, skip scripts/styles/hidden
        const textSelectors = 'p, span, div, strong, em, b, i, li, td, th, h1, h2, h3, h4, h5, h6, label, address, blockquote, pre, code, canvas, img';
        for (const el of document.querySelectorAll(textSelectors)) {
            if (seen.has(el)) continue;

            // Skip if no direct text content (but allow canvas/img through for OCR trigger)
            const tag = el.tagName.toLowerCase();
            if (tag !== 'canvas' && tag !== 'img') {
                const text = this._getDirectText(el);
                if (!text || text.length < 3) continue;
            }

            // Skip hidden elements
            if (!this.isVisible(el)) continue;

            // Skip nested duplicates: if parent already captured same text, skip
            if (this._parentAlreadyCaptured(el, seen)) continue;

            results.push(this.analyzeElement(el));
            seen.add(el);
        }

        return results;
    }

    /** Get only direct text of element, excluding child element text to avoid duplication */
    _getDirectText(element) {
        let text = '';
        for (const node of element.childNodes) {
            if (node.nodeType === 3) { // TEXT_NODE
                text += node.textContent;
            }
        }
        return text.trim();
    }

    /** Check if a parent element was already captured to avoid nested duplication */
    _parentAlreadyCaptured(element, seen) {
        let parent = element.parentElement;
        while (parent) {
            if (seen.has(parent)) return true;
            parent = parent.parentElement;
        }
        return false;
    }
}
