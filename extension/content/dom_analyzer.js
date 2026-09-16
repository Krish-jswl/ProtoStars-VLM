
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
            text: (element.innerText || element.textContent || '').substring(0, 100).trim() || '',
            bbox: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
            },
            visible: this.isVisible(element),
            enabled: !element.disabled,
            inputType: element.type || ''
        };
    }

    analyzeDOM() {
        const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
        const elements = document.querySelectorAll(interactiveSelectors);
        const results = [];
        for (let el of elements) {
            results.push(this.analyzeElement(el));
        }
        return results;
    }
}
