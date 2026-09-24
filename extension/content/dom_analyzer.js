export class DOMAnalyzer {
    isVisible(element) {
        if (!element || element.nodeType !== 1) return false;
        
        // Modern Chrome API — catches ALL CSS hiding (clip, overflow, etc.)
        if (typeof element.checkVisibility === 'function') {
            if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        }
        
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        if (rect.width === 0 || rect.height === 0) return false;
        if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
        
        // Check if element is clipped by parent overflow
        let parent = element.parentElement;
        while (parent && parent !== document.body) {
            const ps = window.getComputedStyle(parent);
            if (ps.overflow === 'hidden' || ps.overflowY === 'hidden') {
                const pr = parent.getBoundingClientRect();
                // Element is fully clipped by parent
                if (rect.bottom > pr.bottom + 2 || rect.top < pr.top - 2 || 
                    rect.right > pr.right + 2 || rect.left < pr.left - 2) {
                    // Check if the visible portion is meaningful (> 10px)
                    const visibleH = Math.min(rect.bottom, pr.bottom) - Math.max(rect.top, pr.top);
                    const visibleW = Math.min(rect.right, pr.right) - Math.max(rect.left, pr.left);
                    if (visibleH < 10 || visibleW < 10) return false;
                }
            }
            parent = parent.parentElement;
        }

        return true;
    }

    analyzeElement(element) {
        if (!element.id) {
            if (!element.dataset?.pvaId) {
                if (element.dataset) element.dataset.pvaId = "pva-" + Math.random().toString(36).substring(2, 8);
            }
            element.id = element.dataset?.pvaId || ("pva-" + Math.random().toString(36).substring(2, 8));
        }
        const rect = element.getBoundingClientRect();
        const tag = element.tagName.toLowerCase();

        let text = '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            text = (element.value || '').substring(0, 200).trim();
        } else {
            text = this._getDirectText(element).substring(0, 200);
        }

        return {
            id: element.id || '',
            role: element.getAttribute('role') || '',
            tag,
            text,
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

        // 1. Interactive elements — WITH visibility check
        const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
        for (const el of document.querySelectorAll(interactiveSelectors)) {
            if (!this.isVisible(el)) continue;
            results.push(this.analyzeElement(el));
            seen.add(el);
        }

        // 2. Visible text-bearing elements
        const textSelectors = 'p, span, div, strong, em, b, i, li, td, th, h1, h2, h3, h4, h5, h6, label, address, blockquote, pre, code, canvas, img';
        for (const el of document.querySelectorAll(textSelectors)) {
            if (seen.has(el)) continue;
            const tag = el.tagName.toLowerCase();
            if (tag !== 'canvas' && tag !== 'img') {
                const text = this._getDirectText(el);
                if (!text || text.length < 3) continue;
            }
            if (!this.isVisible(el)) continue;
            if (this._parentAlreadyCaptured(el, seen)) continue;
            results.push(this.analyzeElement(el));
            seen.add(el);
        }

        return results;
    }

    _getDirectText(element) {
        let text = '';
        for (const node of element.childNodes) {
            if (node.nodeType === 3) text += node.textContent;
        }
        return text.trim();
    }

    _parentAlreadyCaptured(element, seen) {
        let parent = element.parentElement;
        while (parent) {
            if (seen.has(parent)) return true;
            parent = parent.parentElement;
        }
        return false;
    }
}
