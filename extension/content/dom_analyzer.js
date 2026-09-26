export class DOMAnalyzer {
    constructor() {
        this._generatedIds = new WeakMap();
        this._nativeIds = new WeakMap();
        this._seenNativeIds = new Set();
        this._fingerprintIds = new Map();
        this._idCounter = 0;
    }

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

        // Keep off-screen controls in the observation. The planner can then
        // request a scroll/click, and the executor scrolls a target into view
        // immediately before acting.
        
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
        this._ensureStableId(element);
        const rect = element.getBoundingClientRect();
        const tag = element.tagName.toLowerCase();
        const isContentEditable = this._isContentEditable(element);

        let text = '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            text = (element.value || '').substring(0, 200).trim();
        } else if (isContentEditable) {
            text = (element.innerText || element.textContent || '').substring(0, 200).trim();
        } else {
            text = this._getDirectText(element).substring(0, 200);
            if (!text && ['button', 'a', 'summary', 'label'].includes(tag)) {
                text = String(element.innerText || element.textContent || '').trim().substring(0, 200);
                if (!text) {
                    text = String(element.querySelector?.('img[alt]')?.getAttribute('alt') || '').trim().substring(0, 200);
                }
            }
        }

        return {
            id: element.id || '',
            role: element.getAttribute('role') || this._implicitRole(element, tag),
            tag,
            text,
            bbox: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
            },
            visible: this.isVisible(element),
            enabled: !element.disabled && element.getAttribute('aria-disabled') !== 'true',
            readOnly: !!element.readOnly || element.getAttribute('aria-readonly') === 'true',
            inputType: isContentEditable ? 'contenteditable' : (element.type || ''),
            autocomplete: element.getAttribute('autocomplete') || '',
            // Safe semantic labels give the planner enough information to find
            // controls on pages whose visible text is only in a placeholder or
            // accessibility label.  Values are never included here.
            placeholder: element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || '',
            ariaLabel: element.getAttribute('aria-label') || '',
            name: element.getAttribute('name') || '',
            title: element.getAttribute('title') || '',
            testId: element.getAttribute('data-testid') ||
                element.getAttribute('data-test-id') ||
                element.getAttribute('data-qa') || '',
            label: this._getLabel(element),
            ariaExpanded: this._ariaState(element, 'aria-expanded', ['true', 'false', 'undefined']),
            ariaSelected: this._ariaState(element, 'aria-selected', ['true', 'false']),
            ariaChecked: this._ariaState(element, 'aria-checked', ['true', 'false', 'mixed']),
            ariaCurrent: this._ariaState(element, 'aria-current', ['page', 'step', 'location', 'date', 'time', 'true', 'false']),
            ariaPressed: this._ariaState(element, 'aria-pressed', ['true', 'false', 'mixed']),
            ariaHasPopup: this._ariaState(element, 'aria-haspopup', ['false', 'true', 'menu', 'listbox', 'tree', 'grid', 'dialog']),
            // tabIndex is included so that grounding can recognise elements
            // that are keyboard-focusable but carry no explicit ARIA role.
            tabIndex: typeof element.tabIndex === 'number' ? element.tabIndex : -1,
            options: tag === 'select'
                ? Array.from(element.options || []).slice(0, 100).map(option =>
                    (option.textContent || '').trim().substring(0, 200)
                )
                : []
        };
    }

    analyzeDOM() {
        const results = [];
        const seen = new Set();

        // 1. Interactive elements — WITH visibility check
        const interactiveSelectors = 'button, a, input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="radio"], [role="option"], [role="treeitem"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], [tabindex]:not([tabindex="-1"])';
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

    _ariaState(element, attribute, allowed) {
        const value = String(element.getAttribute?.(attribute) || '').trim().toLowerCase();
        return allowed.includes(value) ? value : '';
    }

    _implicitRole(element, tag) {
        if (tag === 'button') return 'button';
        if (tag === 'a' && (element.getAttribute('href') !== null || element.hasAttribute('tabindex'))) return 'link';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'combobox';
        if (tag === 'input') {
            const type = String(element.type || 'text').toLowerCase();
            if (['button', 'submit', 'reset'].includes(type)) return 'button';
            if (['checkbox', 'radio'].includes(type)) return type;
            if (['email', 'tel', 'url', 'search', 'text', 'password', 'number'].includes(type)) return 'textbox';
        }
        return '';
    }

    _ensureStableId(element) {
        const nativeId = String(element.id || '').trim();
        const knownNative = this._nativeIds.get(element);
        if (knownNative) {
            element.id = knownNative;
            return knownNative;
        }
        if (nativeId && /^[A-Za-z0-9_-]+$/.test(nativeId) &&
            !/^pva-/i.test(nativeId) && !this._seenNativeIds.has(nativeId)) {
            this._seenNativeIds.add(nativeId);
            this._nativeIds.set(element, nativeId);
            return nativeId;
        }
        const existing = this._generatedIds.get(element);
        if (existing) {
            element.id = existing;
            return existing;
        }

        const declared = String(element.getAttribute?.('data-pva-id') || '').trim();
        if (/^pva-[a-z0-9]+$/i.test(declared)) {
            element.id = declared;
            this._generatedIds.set(element, declared);
            this._nativeIds.set(element, declared);
            return declared;
        }

        const fingerprint = this._elementFingerprint(element);
        let id = this._fingerprintIds.get(fingerprint);
        if (!id) {
            id = `pva-${this._hash(fingerprint)}`;
            this._fingerprintIds.set(fingerprint, id);
        }
        // A semantic fingerprint can legitimately occur more than once.  The
        // DOM path is part of the fingerprint, but retain a collision guard for
        // malformed pages and duplicate attributes.
        let candidate = id;
        while (this._fingerprintIds.get(`used:${candidate}`) &&
               this._fingerprintIds.get(`used:${candidate}`) !== fingerprint) {
            this._idCounter += 1;
            candidate = `${id}-${this._idCounter.toString(36)}`;
        }
        this._fingerprintIds.set(`used:${candidate}`, fingerprint);
        element.id = candidate;
        if (element.dataset) element.dataset.pvaId = candidate;
        this._generatedIds.set(element, candidate);
        this._nativeIds.set(element, candidate);
        return candidate;
    }

    _elementFingerprint(element) {
        const path = [];
        let current = element;
        while (current && current.nodeType === 1 && path.length < 8) {
            let segment = current.tagName?.toLowerCase() || 'node';
            if (current.id) segment += `#${current.id}`;
            else {
                const parent = current.parentElement;
                if (parent) {
                    const index = Array.prototype.indexOf.call(parent.children || [], current);
                    segment += `[${index >= 0 ? index : 0}]`;
                }
            }
            path.unshift(segment);
            current = current.parentElement;
        }
        const accessible = [
            element.getAttribute?.('role') || '',
            element.getAttribute?.('aria-label') || '',
            element.getAttribute?.('name') || '',
            element.getAttribute?.('placeholder') || '',
            element.getAttribute?.('type') || '',
            this._getLabel(element),
            this._getDirectText(element)
        ].join('|');
        return `${path.join('/')}::${accessible}`;
    }

    _hash(value) {
        let hash = 2166136261;
        for (let index = 0; index < value.length; index++) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    _getLabel(element) {
        try {
            if (element.labels && element.labels.length) {
                return (element.labels[0].textContent || '').trim().substring(0, 200);
            }
            const nested = element.closest?.('label');
            if (nested) return (nested.textContent || '').trim().substring(0, 200);
            if (element.id) {
                for (const label of document.querySelectorAll('label')) {
                    if (label.htmlFor === element.id) {
                        return (label.textContent || '').trim().substring(0, 200);
                    }
                }
            }
            const labelledBy = element.getAttribute?.('aria-labelledby');
            if (labelledBy) {
                const text = labelledBy.split(/\s+/)
                    .map(id => document.getElementById(id)?.textContent || '')
                    .join(' ')
                    .trim();
                if (text) return text.substring(0, 200);
            }
            const title = element.getAttribute?.('title');
            if (title) return title.trim().substring(0, 200);
            const alt = element.getAttribute?.('alt');
            if (alt) return alt.trim().substring(0, 200);
        } catch (_) {
            // A malformed/custom label must not prevent observation.
        }
        return '';
    }

    _isContentEditable(element) {
        const tag = element?.tagName?.toLowerCase();
        if (['input', 'textarea', 'select', 'button', 'a'].includes(tag)) return false;
        const raw = element?.getAttribute?.('contenteditable');
        if (raw !== null && raw !== undefined) {
            const value = String(raw).toLowerCase();
            return value === '' || value === 'true' || value === 'plaintext-only';
        }
        const ancestor = element?.closest?.('[contenteditable]');
        if (ancestor && ancestor !== element) {
            const value = String(ancestor.getAttribute('contenteditable') || '').toLowerCase();
            return value === '' || value === 'true' || value === 'plaintext-only';
        }
        return false;
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
