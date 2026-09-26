/**
 * Deterministic target grounding for browser actions.
 *
 * Action plans contain opaque element IDs, not selectors or executable code.
 * When an SPA replaces a node, the ID can disappear even though the same
 * semantic control is still present.  This module re-resolves an action from
 * the current observation using only bounded, non-executable UI metadata.
 */

const ARTICLE_TOKENS = new Set(['a', 'an', 'the']);
const TOKEN_SYNONYMS = Object.freeze({
    create: 'add',
    created: 'add',
    creating: 'add',
    new: 'add',
    submit: 'save',
    sent: 'submit',
    send: 'submit',
    okay: 'confirm',
    ok: 'confirm'
});

export const SAFE_KEYS = Object.freeze(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown']);

export function normalizeText(value, max = 300) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/&/g, ' and ')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function singularize(token) {
    if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (token.length > 3 && token.endsWith('es') && !token.endsWith('ses')) return token.slice(0, -2);
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
    return token;
}

function canonicalTokens(value) {
    const normalized = normalizeText(value);
    if (!normalized) return [];
    return normalized
        .split(' ')
        .filter(token => !ARTICLE_TOKENS.has(token))
        .map(token => TOKEN_SYNONYMS[token] || singularize(token));
}

/**
 * Return conservative semantic variants.  Matching is intentionally based on
 * tokens rather than substring-only text, so "Add a task" and "Create task"
 * can be grounded without accepting an arbitrary selector.
 */
export function labelVariants(value) {
    const normalized = normalizeText(value);
    if (!normalized) return [];
    const tokens = canonicalTokens(normalized);
    const canonical = tokens.join(' ');
    const compact = normalized.split(' ').filter(token => !ARTICLE_TOKENS.has(token)).join(' ');
    return [...new Set([normalized, compact, canonical].filter(Boolean))];
}

export function isSafeElementId(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text || text.length > 2048) return false;
    // Action targets are IDs.  A selector-looking value is not accepted as a
    // target, even if it happens to be a valid CSS selector.
    return !/[.#\[\](){}>+~,:/\\]/.test(text) || /^pva-[a-z0-9-]+$/i.test(text) ||
        /^#[a-z0-9_-]+$/i.test(text);
}

function usable(node) {
    return node && node.visible !== false && node.enabled !== false && node.id;
}

function textValues(node) {
    return [
        ['ariaLabel', node?.ariaLabel, 32],
        ['label', node?.label, 28],
        ['text', node?.text, 24],
        ['placeholder', node?.placeholder, 18],
        ['name', node?.name, 16],
        ['title', node?.title, 14],
        ['testId', node?.testId, 12],
        ['id', node?.id, 14]
    ].map(([source, value, weight]) => ({
        source,
        weight,
        variants: labelVariants(value)
    })).filter(item => item.variants.length > 0);
}

function normalizedId(value) {
    return normalizeText(String(value || '').replace(/^#/, ''));
}

function compatibleType(actionType, node) {
    if (!actionType || !node) return true;
    const tag = String(node.tag || '').toLowerCase();
    const role = String(node.role || '').toLowerCase();
    const type = String(node.inputType || '').toLowerCase();
    if (actionType === 'click') {
        // Native clickable tags
        if (['button', 'a', 'summary', 'details'].includes(tag)) return true;
        // input[type=submit/button/image/reset] are clickable
        if (tag === 'input' && ['submit', 'button', 'image', 'reset', 'checkbox', 'radio'].includes(type)) return true;
        // Explicit interactive ARIA roles
        if (['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
             'tab', 'checkbox', 'switch', 'radio', 'option', 'treeitem',
             'gridcell', 'columnheader', 'rowheader'].includes(role)) return true;
        // Any element with a tabindex is keyboard-focusable and therefore clickable.
        // The DOMAnalyzer includes tabindex elements in its interactive pass.
        if (node.tabIndex != null && Number(node.tabIndex) >= 0) return true;
        return false;
    }
    if (actionType === 'focus' || actionType === 'type_local') {
        // Native editable tags
        if (tag === 'input' || tag === 'textarea') return true;
        // contenteditable (set by DOMAnalyzer when the attribute is present)
        if (type === 'contenteditable') return true;
        // ARIA text-entry roles — SPA editors frequently use div[role=textbox]
        // without the contenteditable attribute being reflected in inputType.
        if (['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role)) return true;
        return false;
    }
    if (actionType === 'select') return tag === 'select' || role === 'combobox' || role === 'listbox';
    if (actionType === 'keypress') {
        return tag === 'input' || tag === 'textarea' || tag === 'button' || tag === 'a' ||
            type === 'contenteditable' || ['textbox', 'searchbox', 'combobox', 'spinbutton', 'button', 'link', 'menuitem', 'option', 'treeitem'].includes(role);
    }
    return true;
}

function bboxScore(a, b) {
    if (!a || !b) return 0;
    const valuesA = ['x', 'y', 'width', 'height'].map(key => Number(a[key]));
    const valuesB = ['x', 'y', 'width', 'height'].map(key => Number(b[key]));
    if (!valuesA.every(Number.isFinite) || !valuesB.every(Number.isFinite)) return 0;
    const ax = valuesA[0] + valuesA[2] / 2;
    const ay = valuesA[1] + valuesA[3] / 2;
    const bx = valuesB[0] + valuesB[2] / 2;
    const by = valuesB[1] + valuesB[3] / 2;
    const diagonal = Math.max(1, Math.hypot(
        Math.max(valuesA[2], valuesA[3]),
        Math.max(valuesB[2], valuesB[3])
    ));
    const distance = Math.hypot(ax - bx, ay - by);
    return Math.max(0, 8 - (distance / diagonal) * 8);
}

function bboxSpatialMatch(node, bbox) {
    if (!bbox) return 0;
    const score = bboxScore(bbox, node.bbox);
    if (score <= 0) return 0;
    const a = ['x', 'y', 'width', 'height'].map(key => Number(bbox[key]));
    const b = ['x', 'y', 'width', 'height'].map(key => Number(node.bbox?.[key]));
    if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) return 0;
    const overlapLeft = Math.max(a[0], b[0]);
    const overlapTop = Math.max(a[1], b[1]);
    const overlapRight = Math.min(a[0] + a[2], b[0] + b[2]);
    const overlapBottom = Math.min(a[1] + a[3], b[1] + b[3]);
    const overlap = Math.max(0, overlapRight - overlapLeft) * Math.max(0, overlapBottom - overlapTop);
    const area = Math.max(1, a[2] * a[3]);
    return overlap > 0 ? score + Math.min(6, overlap / area * 6) : score;
}

function descriptorScore(node, descriptor) {
    if (!descriptor) return 0;
    let score = 0;
    if (descriptor.id && normalizedId(descriptor.id) === normalizedId(node.id)) score += 100;
    if (descriptor.role && String(descriptor.role).toLowerCase() === String(node.role || '').toLowerCase()) score += 14;
    if (descriptor.tag && String(descriptor.tag).toLowerCase() === String(node.tag || '').toLowerCase()) score += 10;
    if (descriptor.inputType && String(descriptor.inputType).toLowerCase() === String(node.inputType || '').toLowerCase()) score += 8;
    for (const key of ['ariaExpanded', 'ariaSelected', 'ariaChecked', 'ariaCurrent', 'ariaPressed', 'ariaHasPopup']) {
        if (descriptor[key] && String(descriptor[key]).toLowerCase() === String(node[key] || '').toLowerCase()) score += 3;
    }
    for (const item of textValues(descriptor)) {
        const source = item.source;
        const actual = textValues(node).find(candidate => candidate.source === source);
        if (actual?.variants.some(value => item.variants.includes(value))) {
            score += item.weight;
        }
    }
    score += bboxScore(descriptor.bbox, node.bbox);
    return score;
}

function semanticScore(node, wanted) {
    let best = 0;
    for (const item of textValues(node)) {
        for (const candidate of wanted) {
            if (item.variants.includes(candidate)) {
                best = Math.max(best, item.weight + 18);
            } else if (candidate.length >= 4 && item.variants.some(value =>
                value.includes(candidate) || candidate.includes(value)
            )) {
                best = Math.max(best, item.weight);
            }
        }
    }
    return best;
}

function topCandidate(candidates) {
    if (!candidates.length) return { status: 'not-found' };
    candidates.sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
    const first = candidates[0];
    const second = candidates[1];
    // A tie is ambiguity, even if DOM order happens to be deterministic.
    if (second && Math.abs(first.score - second.score) < 1) return { status: 'ambiguous' };
    return { status: 'resolved', target: String(first.node.id).replace(/^#/, ''), ...first };
}

/**
 * Resolve an action target against a fresh observation.
 *
 * `descriptor` is the node observed when the plan was made.  It is used only
 * for re-grounding after a rerender; it is never sent to a page or a provider.
 */
export function resolveTarget(target, domElements, descriptor = null, options = {}) {
    const nodes = (Array.isArray(domElements) ? domElements : []).filter(usable);
    const raw = String(target == null ? '' : target).trim();
    if (!raw) {
        if (options.allowEmpty) return { status: 'resolved', node: null, target: '', grounding: 'empty', score: 0 };
        return { status: 'not-found' };
    }
    if (/javascript\s*:|<\s*script|\beval\s*\(/i.test(raw)) return { status: 'rejected' };

    const wantedId = normalizedId(raw);
    const actionType = options.actionType || '';
    const exact = nodes.find(node => normalizedId(node.id) === wantedId);
    if (exact && (!actionType || compatibleType(actionType, exact))) {
        return { status: 'resolved', node: exact, target: String(exact.id), grounding: 'stable-id', score: 100 };
    }

    const compatible = nodes.filter(node => compatibleType(actionType, node));
    const pool = actionType ? compatible : nodes;
    const wanted = labelVariants(raw);
    const semantic = pool.map(node => ({
        node,
        score: semanticScore(node, wanted) + descriptorScore(node, descriptor),
        grounding: semanticScore(node, wanted) > 0 ? 'semantic' : 'descriptor'
    })).filter(item => item.score > 0);

    if (!semantic.length) {
        // A target that looks like a missing ID must not be treated as a CSS
        // selector.  Only a previously captured descriptor can re-ground it.
        if (descriptor) {
            const descriptorCandidates = pool.map(node => ({
                node,
                score: Math.max(
                    descriptorScore(node, descriptor),
                    bboxSpatialMatch(node, descriptor.bbox)
                ),
                grounding: 'descriptor'
            })).filter(item => item.score >= 8)
              .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
            if (!descriptorCandidates.length) return { status: 'not-found' };
            const result = topCandidate(descriptorCandidates);
            if (result.status !== 'resolved') return { ...result, candidates: descriptorCandidates.slice(0, 5) };
            return { ...result, candidates: descriptorCandidates.slice(0, 5) };
        }
        return { status: 'not-found' };
    }

    const result = topCandidate(semantic);
    if (result.status !== 'resolved') return { ...result, candidates: semantic.slice(0, 5) };

    // Exact semantic labels are safe only when unique.  If a descriptor makes
    // two otherwise identical controls distinguishable by location, require a
    // meaningful score margin; never guess between equal candidates.
    const exactMatches = semantic.filter(item =>
        textValues(item.node).some(value => wanted.includes(value.source === 'id' ? value.variants[0] : value.variants[0]))
    );
    if (exactMatches.length > 1 && !descriptor) {
        return { status: 'ambiguous', candidates: semantic.slice(0, 5) };
    }
    return { ...result, candidates: semantic.slice(0, 5) };
}

export function resolveActionTarget(action, domElements, descriptor = null) {
    const type = action?.type;
    if (type === 'wait' || type === 'done') {
        return { status: 'resolved', node: null, target: '', grounding: 'page', score: 0 };
    }
    if (type === 'scroll') {
        const target = String(action.target || 'body').replace(/^#/, '').toLowerCase();
        if (!target || ['body', 'html', 'window', 'document'].includes(target)) {
            return { status: 'resolved', node: null, target: target || 'body', grounding: 'page', score: 0 };
        }
    }
    if (type === 'keypress' && !String(action.target || '').trim()) {
        return { status: 'resolved', node: null, target: '', grounding: 'active-element', score: 0 };
    }
    return resolveTarget(action?.target, domElements, descriptor, { actionType: type });
}

export function descriptorForNode(node) {
    if (!node) return null;
    return {
        id: String(node.id || '').replace(/^#/, ''),
        tag: String(node.tag || '').slice(0, 40),
        role: String(node.role || '').slice(0, 80),
        inputType: String(node.inputType || '').slice(0, 40),
        ariaExpanded: String(node.ariaExpanded || '').slice(0, 20),
        ariaSelected: String(node.ariaSelected || '').slice(0, 20),
        ariaChecked: String(node.ariaChecked || '').slice(0, 20),
        ariaCurrent: String(node.ariaCurrent || '').slice(0, 40),
        ariaPressed: String(node.ariaPressed || '').slice(0, 20),
        ariaHasPopup: String(node.ariaHasPopup || '').slice(0, 40),
        ariaLabel: String(node.ariaLabel || '').slice(0, 200),
        label: String(node.label || '').slice(0, 200),
        text: String(node.text || '').slice(0, 200),
        placeholder: String(node.placeholder || '').slice(0, 200),
        name: String(node.name || '').slice(0, 200),
        title: String(node.title || '').slice(0, 200),
        testId: String(node.testId || '').slice(0, 200),
        bbox: node.bbox && typeof node.bbox === 'object' ? {
            x: Number(node.bbox.x) || 0,
            y: Number(node.bbox.y) || 0,
            width: Number(node.bbox.width) || 0,
            height: Number(node.bbox.height) || 0
        } : null
    };
}

export function safeCandidateSummary(resolution) {
    return (resolution?.candidates || []).slice(0, 5).map(candidate => {
        const rawId = String(candidate.node?.id || '').replace(/^#/, '');
        let id = rawId;
        if (rawId && !/^pva-[a-z0-9-]+$/i.test(rawId)) {
            let hash = 2166136261;
            for (let index = 0; index < rawId.length; index++) {
                hash ^= rawId.charCodeAt(index);
                hash = Math.imul(hash, 16777619);
            }
            id = `target-${(hash >>> 0).toString(36)}`;
        }
        return {
            id,
            role: String(candidate.node?.role || '').slice(0, 40),
            tag: String(candidate.node?.tag || '').slice(0, 30),
            score: Math.round(Number(candidate.score) || 0),
            grounding: candidate.grounding || 'unknown'
        };
    });
}
