import { Logger } from '../shared/logger.js';
import { validateActionPlan } from './api_client.js';
import { resolveTarget } from './action_grounding.js';

const logger = new Logger('LocalAgent');

export const LOCAL_TASK_POLICY = Object.freeze({
    supported: Object.freeze([
        'click an exact visible button label',
        'focus an exact visible editable field',
        'scroll down or up',
        'open an exact visible link or menu',
        'type ordinary text into an exact editable field',
        'use an allowed local secret reference',
        'press one allowlisted navigation key',
        'send ordinary text through a uniquely grounded message editor',
        'a short sequence of the supported actions'
    ]),
    maxActions: 4,
    maxSequenceClauses: 3,
    serverOnlyMarkers: Object.freeze([
        'ambiguous', 'best', 'cheapest', 'compare', 'complete this',
        'complicated', 'complex', 'explain', 'find', 'investigate',
        'multi-step', 'multistep', 'reason', 'research', 'summarize', 'workflow'
    ])
});

const MAX_LOCAL_ACTIONS = LOCAL_TASK_POLICY.maxActions;
const MAX_SEQUENCE_CLAUSES = LOCAL_TASK_POLICY.maxSequenceClauses;

// How much text a link needs before it can be read as a result title rather
// than page furniture.  A search result carries a descriptive title, while a
// menu, footer or tab label is a word or two.  Both the "is this a result"
// test and the "is this a navigation row" test use this one threshold, so a
// link is either descriptive or it is furniture.
const DESCRIPTIVE_LINK_TEXT = 20;

// The input types that accept free text.  An input element of any other type
// (submit, hidden, file, checkbox, radio, button, image, range, color) cannot
// hold a value the user typed, so it is never a text target.  "password" is
// here because it does hold text: the login planner needs to recognise the
// field, and it is _isOrdinaryEditable that refuses identity and password
// targets for ordinary task text.
const TEXT_ENTRY_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password']);

// Search engines a goal may name.  "search google for X" and "google for X"
// both mean the query is X, so the engine word is part of how the goal is
// phrased and never part of the query itself.
const SEARCH_ENGINE_PATTERN = '(?:google|bing|duckduckgo|brave|ecosia|yahoo)';

const CREDENTIAL_LITERAL_PATTERN = /\b(?:password|passwd|secret|token|api[_ -]?key|private[_ -]?key)\b\s*(?:is|=|:)\s*\S+/i;

const SENSITIVE_TEXT_PATTERNS = [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4,10}/,
    /\b(?:\d[ -]*?){13,19}\b/,
    /\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,})\b/
];

function normalize(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripQuotes(value) {
    const text = String(value || '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1).trim();
    }
    return text;
}

function findConnectorOutsideQuotes(text, connectors) {
    let quote = null;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (quote) {
            if (character === quote && text[index - 1] !== '\\') quote = null;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        for (const connector of connectors) {
            const candidate = ` ${connector} `;
            if (normalize(text.slice(index, index + candidate.length)) === normalize(candidate)) {
                return { index, length: candidate.length, connector };
            }
        }
    }
    return null;
}

function splitSequence(text) {
    const parts = [];
    let start = 0;
    while (start <= text.length) {
        const connector = findConnectorOutsideQuotes(text.slice(start), ['then', 'and']);
        if (!connector) {
            parts.push(text.slice(start).trim());
            break;
        }
        const absolute = start + connector.index;
        const part = text.slice(start, absolute).trim();
        if (!part) return [];
        parts.push(part);
        start = absolute + connector.length;
    }
    return parts.filter(Boolean);
}

export class LocalAgent {
    constructor({ validator = validateActionPlan } = {}) {
        this.validator = validator;
    }

    /**
     * Classify and, when safe, plan a small deterministic task locally.
     * The result never contains page-derived raw text except ordinary text
     * explicitly supplied by the user in a type instruction.
     */
    analyze(goal, domElements, context = {}) {
        const rawGoal = String(goal || '').trim();
        const normalizedGoal = normalize(rawGoal);
        const nodes = this._usableNodes(domElements);

        let decision;
        if (!rawGoal || rawGoal.length > 500) {
            decision = this._server('goal is empty or too long');
        } else if (this._containsSensitiveLiteral(rawGoal)) {
            decision = {
                ...this._server('goal contains a sensitive literal'),
                blockEscalation: true
            };
        } else if (this._hasVisualQualifier(rawGoal)) {
            decision = this._server('target requires visual grounding');
        } else if (LOCAL_TASK_POLICY.serverOnlyMarkers.some(marker => {
            const normalizedMarker = normalize(marker);
            return normalizedMarker.includes(' ')
                ? normalizedGoal.includes(normalizedMarker)
                : new RegExp(`\\b${normalizedMarker.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`).test(normalizedGoal);
        })) {
            decision = this._server('task requires complex reasoning');
        } else {
            const sequence = this._planSequence(rawGoal, nodes, context);
            if (sequence?.actions) {
                decision = this._local(sequence.actions, sequence.reason);
            } else {
                const whole = this._planClause(rawGoal, nodes, context);
                decision = whole?.actions
                    ? this._local(whole.actions, whole.reason)
                    : whole?.blockEscalation
                        ? { ...this._server(whole.reason), blockEscalation: true }
                        : this._server(whole?.reason || 'no exact local target matched');
            }
        }

        logger.info(`decision = ${decision.decision}`, { reason: decision.reason });
        return decision;
    }

    _hasVisualQualifier(text) {
        return /\b(?:blue|red|green|yellow|orange|purple|pink|gray|grey|black|white|top|bottom|left|right|floating|colored|colour)\b/i.test(String(text || ''));
    }

    _containsSensitiveLiteral(text) {
        return CREDENTIAL_LITERAL_PATTERN.test(text) ||
            SENSITIVE_TEXT_PATTERNS.some(pattern => pattern.test(text));
    }

    _server(reason) {
        return { decision: 'SERVER', reason, actions: [] };
    }

    _local(actions, reason) {
        if (!Array.isArray(actions) || actions.length === 0) {
            return this._server('local planner produced no executable action');
        }
        const validated = this.validator(actions);
        if (!validated.ok) {
            logger.warn('Local plan rejected by shared action validator', {
                reason: validated.error
            });
            return this._server('local plan failed safety validation');
        }
        if (validated.actions.length > MAX_LOCAL_ACTIONS) {
            return this._server('local plan exceeds safe action limit');
        }
        return {
            decision: 'LOCAL',
            reason,
            actions: validated.actions
        };
    }

    _usableNodes(domElements) {
        return (Array.isArray(domElements) ? domElements : [])
            .filter(node => node?.id && node.visible !== false && node.enabled !== false);
    }

    _planSequence(goal, nodes, context = {}) {
        const clauses = splitSequence(goal);
        if (clauses.length < 2 || clauses.length > MAX_SEQUENCE_CLAUSES) return null;

        const plans = clauses.map(clause => this._planClause(clause, nodes, context));
        const firstMissing = plans.findIndex(plan => !plan?.actions);
        if (firstMissing < 0) {
            const actions = [];
            let hasTerminal = false;
            for (const plan of plans) {
                for (const action of plan.actions) {
                    if (action.type === 'done') hasTerminal = true;
                    else actions.push(action);
                }
            }
            if (hasTerminal || !actions.length) actions.push({ type: 'done', target: '', args: {} });
            return {
                actions,
                reason: 'matched a short exact local form sequence'
            };
        }

        // Handle a login → task sequence across a navigation: execute the
        // currently available login prefix now, then re-observe and plan the
        // task clause after the page changes. Never substitute the login
        // email field for a missing task composer.
        const prefixPlans = plans.slice(0, firstMissing).filter(plan => plan?.actions);
        if (prefixPlans.length) {
            const actions = [];
            let hasTerminal = false;
            for (const plan of prefixPlans) {
                for (const action of plan.actions) {
                    if (action.type === 'done') hasTerminal = true;
                    else actions.push(action);
                }
            }
            if (actions.length) {
                return {
                    actions,
                    reason: 'matched the first available step of a local sequence'
                };
            }
        }

        // If login is already complete, skip that clause and use a task plan
        // that is visible now.
        if (/\b(?:log\s*in|login|sign\s*in|signin)\b/i.test(clauses[firstMissing] || '')) {
            const later = plans.slice(firstMissing + 1).find(plan => plan?.actions);
            if (later) return { ...later, reason: 'skipped an already-completed local sequence step' };
        }
        return null;
    }

    _planClause(goal, nodes, context = {}) {
        const text = String(goal || '').trim();
        const lower = text.toLowerCase();

        const search = this._planSearch(text, nodes);
        if (search) return search;

        const keypress = text.match(/^(?:please\s+)?(?:press|hit|send)\s+(enter|escape|tab|arrow\s+up|arrow\s+down)(?:\s+to\s+submit)?$/i);
        if (keypress) {
            const keyName = keypress[1].toLowerCase().replace(/\s+/g, '');
            const key = keyName === 'arrowup' ? 'ArrowUp' :
                keyName === 'arrowdown' ? 'ArrowDown' :
                    keyName.charAt(0).toUpperCase() + keyName.slice(1);
            return {
                actions: [
                    { type: 'keypress', target: '', args: { key } },
                    { type: 'done', target: '', args: {} }
                ],
                reason: 'matched an allowlisted navigation key'
            };
        }

        const message = this._planMessage(text, nodes, context);
        if (message) return message;

        const priority = this._planPriority(text, nodes);
        if (priority) return priority;

        const scroll = lower.match(/^(?:please\s+)?scroll\s+(down|up)$/i);
        if (scroll) {
            return {
                actions: [
                    {
                        type: 'scroll',
                        target: 'body',
                        args: { x: 0, y: scroll[1].toLowerCase() === 'down' ? 600 : -600 }
                    },
                    { type: 'done', target: '', args: {} }
                ],
                reason: 'matched exact scroll instruction'
            };
        }

        const click = text.match(/^(?:please\s+)?click\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
        if (click) {
            const target = this._findNamedNode(nodes, click[1], node => this._isButton(node));
            if (target) {
                return {
                    actions: [
                        { type: 'click', target: target.id, args: {} },
                        { type: 'done', target: '', args: {} }
                    ],
                    reason: 'matched exact visible button label'
                };
            }
            return { reason: this._ambiguityReason(nodes, click[1], node => this._isButton(node)) };
        }

        const open = text.match(/^(?:please\s+)?open\s+(?:the\s+)?(.+)$/i);
        if (open) {
            const target = this._findNamedNode(nodes, open[1], node => this._isLinkOrMenu(node));
            if (target) {
                return {
                    actions: [
                        { type: 'click', target: target.id, args: {} },
                        { type: 'done', target: '', args: {} }
                    ],
                    reason: 'matched exact visible link or menu label'
                };
            }
            return { reason: this._ambiguityReason(nodes, open[1], node => this._isLinkOrMenu(node)) };
        }

        const focus = text.match(/^(?:please\s+)?focus\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
        if (focus) {
            const target = this._findNamedNode(nodes, focus[1], node => this._isEditable(node));
            if (target) {
                return {
                    actions: [
                        { type: 'focus', target: target.id, args: {} },
                        { type: 'done', target: '', args: {} }
                    ],
                    reason: 'matched exact visible editable field'
                };
            }
            return { reason: this._ambiguityReason(nodes, focus[1], node => this._isEditable(node)) };
        }

        const task = this._planTaskCreate(text, nodes);
        if (task) return task;

        const secret = this._planSecretType(text, nodes);
        if (secret) return secret;

        const ordinary = this._planOrdinaryType(text, nodes);
        if (ordinary) return ordinary;

        const login = this._planLogin(text, nodes);
        if (login) return login;

        return null;
    }

    _parseMessageGoal(goal) {
        const raw = String(goal || '').trim();
        if (!raw) return null;

        // Prefer an explicitly quoted message. This keeps natural-language
        // destination phrases such as "in the text box" out of the text sent
        // to the conversation.
        const quoted = raw.match(/"([^"]+)"|'([^']+)'/);
        if (quoted) {
            const before = raw.slice(0, quoted.index).trim();
            const after = raw.slice(quoted.index + quoted[0].length).trim();
            const prefix = /^(?:please\s+)?send(?:\s+|$)(?:(?:the|a|an)\s+)?(?:(?:message|text)(?:\s+message)?\s*)?$/i;
            const destination = /^(?:in|into|to|on)\s+(?:the\s+)?(?:text(?:ed)?\s*box|textbox|message\s+box|chat|conversation)$/i;
            const destinationText = after.replace(/[.!?]+$/, '').trim();
            if (!prefix.test(before) || (after && !destination.test(destinationText))) return null;
            return { text: (quoted[1] ?? quoted[2]).trim() };
        }

        // Keep an unquoted form available for short commands, but require the
        // same explicit destination vocabulary so arbitrary prose is not
        // accidentally typed into a message box.
        const unquoted = raw.match(
            /^(?:please\s+)?send\s+(?:(?:the|a|an)\s+)?(?:message\s+|text\s+)?(.+?)(?:\s+(?:in|into|to|on)\s+(?:the\s+)?(?:text(?:ed)?\s*box|textbox|message\s+box|chat|conversation))?$/i
        );
        if (!unquoted) return null;
        return { text: stripQuotes(unquoted[1]).trim() };
    }

    _planMessage(goal, nodes, context = {}) {
        const parsed = this._parseMessageGoal(goal);
        if (!parsed) return null;
        const text = parsed.text;
        if (!text || text.length > 200 || SENSITIVE_TEXT_PATTERNS.some(pattern => pattern.test(text))) {
            return text ? { ...this._server('message text contains a sensitive literal'), blockEscalation: true } : null;
        }

        const editors = nodes
            .filter(node => this._isOrdinaryEditable(node))
            .map(node => ({ node, score: this._messageEditorScore(node) }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
        if (!editors.length || (editors[1] && editors[0].score === editors[1].score)) {
            return { reason: 'message editor is missing or ambiguous' };
        }
        const editor = editors[0].node;
        if (this._textIsVisibleAsContent(nodes, text)) {
            return {
                actions: [{ type: 'done', target: '', args: {} }],
                reason: 'requested message is already visible'
            };
        }

        // Once the local action layer has verified a type operation, do not
        // require the page to echo the draft text back in the next snapshot.
        // Some editors reset their DOM immediately after input; retyping here
        // would duplicate the draft or leave it stranded.
        const draft = String(context.messageDraft || '').trim();
        if (draft && normalize(draft) === normalize(text)) {
            const sendButton = this._findMessageButton(nodes);
            if (sendButton) {
                return {
                    actions: [{ type: 'click', target: sendButton.id, args: {} }],
                    reason: 'submitted the verified message draft through the grounded send control'
                };
            }
            // Give a controlled editor a couple of fresh observations to
            // expose/enable its send control before falling back to Enter.
            if (Number(context.messageDraftPolls || 0) < 2) {
                return { reason: 'message send control is not ready yet' };
            }
            return {
                actions: [{ type: 'keypress', target: editor.id, args: { key: 'Enter' } }],
                reason: 'submitted the verified message draft with Enter'
            };
        }

        if (!this._containsText(editor, text)) {
            return {
                actions: [
                    { type: 'focus', target: editor.id, args: {} },
                    { type: 'type_local', target: editor.id, args: { text } }
                ],
                reason: 'entered text into the grounded message editor'
            };
        }

        const sendButton = this._findMessageButton(nodes);
        if (sendButton) {
            return {
                actions: [{ type: 'click', target: sendButton.id, args: {} }],
                reason: 'submitted text through the grounded send control'
            };
        }
        return {
            actions: [{ type: 'keypress', target: editor.id, args: { key: 'Enter' } }],
            reason: 'submitted message text with Enter'
        };
    }

    /**
     * Generic task-priority assignment.
     *
     * This is expressed purely in roles and accessible names, so it applies to
     * any task UI (Todoist, Asana, Linear, ...) without a site-specific
     * selector.  Two grounded steps are involved: open the priority control on
     * the task row, then choose a level from the revealed menu.
     */
    _planPriority(goal, nodes) {
        if (!/\bpriorit(?:y|ies)\b/i.test(String(goal || ''))) return null;
        if (!/\b(?:set|assign|change|give|add|mark|make|update|increase|decrease|raise|lower|edit|change|choose|select|open|show)\b/i.test(goal) &&
            !/\bpriority\b/i.test(goal)) return null;

        const level = this._requestedPriorityLevel(goal);

        // 1. A revealed menu lets us choose the level directly.  When the goal
        // names no level and several options are equally plausible, guessing
        // would silently set the wrong priority, so this stays ambiguous.
        const options = nodes
            .filter(node => this._isPriorityOption(node))
            .map(node => ({ node, score: this._priorityOptionScore(node, level) }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
        const best = options[0];
        const clearWinner = best && (options.length === 1 || best.score > (options[1]?.score ?? 0));
        if (best && clearWinner) {
            return {
                actions: [
                    { type: 'click', target: best.node.id, args: {} },
                    { type: 'done', target: '', args: {} }
                ],
                reason: 'selected the priority level in the revealed menu'
            };
        }
        if (best && options.length > 1 && !level) {
            return { reason: 'priority level is ambiguous; name the level such as priority 1 or high' };
        }

        // 2. Otherwise open the priority control on the task row.  This is
        // deliberately non-terminal: the menu is not visible yet.
        const openers = nodes
            .filter(node => this._isPriorityOpener(node))
            .sort((a, b) => this._priorityOpenerScore(b) - this._priorityOpenerScore(a) ||
                String(a.id).localeCompare(String(b.id)));
        const topOpener = openers[0];
        const openerIsClear = topOpener && (openers.length === 1 ||
            this._priorityOpenerScore(topOpener) > this._priorityOpenerScore(openers[1] || {}));
        if (openerIsClear) {
            return {
                actions: [{ type: 'click', target: topOpener.id, args: {} }],
                reason: 'opened the task priority control to reveal the level menu'
            };
        }

        return { reason: 'priority control is not grounded' };
    }

    _priorityHaystack(node) {
        return [node.id, node.name, node.text, node.ariaLabel, node.placeholder, node.label, node.title, node.testId, node.role]
            .filter(Boolean).join(' ').toLowerCase();
    }

    _requestedPriorityLevel(goal) {
        const text = String(goal || '').toLowerCase();
        const numeric = text.match(/\bpriority\s*([1-4])\b/) || text.match(/\bp([1-4])\b/);
        if (numeric) return `p${numeric[1]}`;
        if (/\b(?:highest|urgent|critical|p1)\b/.test(text)) return 'p1';
        if (/\b(?:high(?:est)?|p2)\b/.test(text)) return 'p2';
        if (/\b(?:medium|p3)\b/.test(text)) return 'p3';
        if (/\b(?:low(?:est)?|none|p4)\b/.test(text)) return 'p4';
        return '';
    }

    /**
     * A priority *level* ("Priority 1", "p1", "High") is distinct from the
     * control that *opens* the menu ("Set priority for Study Cpp").  Only the
     * former completes the assignment; the latter must stay non-terminal so
     * the revealed menu can be observed on the next cycle.
     */
    _priorityLevelToken(node) {
        const haystack = this._priorityHaystack(node);
        const numeric = haystack.match(/\bpriority\s*([1-4])\b/) || haystack.match(/\bp([1-4])\b/);
        if (numeric) return `p${numeric[1]}`;
        if (/\b(?:urgent|critical|highest)\b/.test(haystack)) return 'p1';
        if (/\bhigh\b/.test(haystack)) return 'p2';
        if (/\bmedium\b/.test(haystack)) return 'p3';
        if (/\b(?:low|lowest|none)\b/.test(haystack)) return 'p4';
        return '';
    }

    _isPriorityOption(node) {
        const haystack = this._priorityHaystack(node);
        if (!/\bpriorit/.test(haystack)) return false;
        if (/\b(?:search|filter|find)\b/.test(haystack)) return false;
        return !!this._priorityLevelToken(node);
    }

    _priorityOptionScore(node, level) {
        // Without a requested level every option scores identically, so the
        // planner reports ambiguity instead of silently choosing one.
        if (!level) return 1;
        // Compare normalized level tokens: a node may spell its level as
        // "Priority 1", "p1", or "High", which never matches as raw substrings.
        return this._priorityLevelToken(node) === level ? 7 : 1;
    }

    _isPriorityOpener(node) {
        const haystack = this._priorityHaystack(node);
        if (!/\bpriorit/.test(haystack)) return false;
        if (/\b(?:search|filter|find)\b/.test(haystack)) return false;
        // A level option is handled by the branch above, not as an opener.
        if (this._isPriorityOption(node)) return false;
        const role = String(node.role || '').toLowerCase();
        const tag = String(node.tag || '').toLowerCase();
        return ['button', 'a', 'img', 'svg'].includes(tag) || ['button', 'link', 'img', 'menuitem'].includes(role);
    }

    _priorityOpenerScore(node) {
        if (!node) return -1;
        const haystack = this._priorityHaystack(node);
        let score = 1;
        if (/\bset\b/.test(haystack)) score += 3;
        if (/\bfor\b/.test(haystack)) score += 1;
        if (/\bpriority\b/.test(haystack)) score += 2;
        if (/\bpriorit/.test(haystack) && !/\bpriority\s*[1-4]\b/.test(haystack)) score += 2;
        return score;
    }

    _messageEditorScore(node) {
        const haystack = this._haystack(node);
        if (/\b(?:search|filter|find)\b/.test(haystack)) return 0;
        let score = 0;
        if (/\b(?:message|chat|conversation|reply|write)\b/.test(haystack)) score += 6;
        if (String(node.inputType || '').toLowerCase() === 'contenteditable') score += 4;
        if (['textbox', 'searchbox', 'combobox'].includes(String(node.role || '').toLowerCase())) score += 2;
        if (String(node.tag || '').toLowerCase() === 'textarea') score += 1;
        return score;
    }

    _findMessageButton(nodes) {
        const candidates = nodes
            .filter(node => this._isButton(node))
            .map(node => {
                const haystack = this._haystack(node);
                let score = 0;
                if (/\bsend\b/.test(haystack)) score += 5;
                if (/\b(?:message|chat)\b/.test(haystack)) score += 2;
                if (/\bsubmit\b/.test(haystack)) score += 1;
                return { node, score };
            })
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
        if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score)) return null;
        return candidates[0].node;
    }

    /**
     * Plan a search: put the query into a search control, then open the first
     * result once results exist.
     *
     * This is the one place ordinary text is allowed into a search field, and
     * only because searching is what the goal asked for.  The intent is read
     * first and the page is only interpreted as a result set when a search
     * control is actually present, so a page that merely contains links is
     * never mistaken for search results.
     */
    _planSearch(goal, nodes) {
        const intent = this._searchIntent(goal);
        if (!intent) return null;

        const field = this._findSearchField(nodes);
        if (!field) {
            return intent.openFirst
                ? { reason: 'no search control is present to read results from' }
                : { reason: 'no search field is available' };
        }

        const typed = this._fieldText(field);
        const queryEntered = !intent.query ||
            typed.toLowerCase() === intent.query.toLowerCase();

        // Results sitting under the query box mean the search already ran, so
        // the query step is finished.  Without this the goal would submit the
        // same search again on every later cycle.
        const first = this._firstResultLink(nodes, field, intent.query);
        const searched = first.status === 'ok' || first.status === 'ambiguous';

        // A result set is only plausible underneath a search control: the
        // results and the query box travel together.
        if (intent.openFirst) {
            if (first.status === 'ambiguous') {
                return { reason: 'more than one candidate first result; refusing to guess' };
            }
            if (first.node) {
                return {
                    actions: [
                        { type: 'click', target: first.node.id, args: {} },
                        { type: 'done', target: '', args: {} }
                    ],
                    reason: 'opened the first search result'
                };
            }
        }

        if (!queryEntered) {
            return {
                actions: [
                    { type: 'focus', target: field.id, args: {} },
                    { type: 'type_local', target: field.id, args: { text: intent.query } },
                    { type: 'done', target: '', args: {} }
                ],
                reason: 'entered the search query in the search field'
            };
        }
        if (searched) {
            return {
                actions: [{ type: 'done', target: '', args: {} }],
                reason: 'the search query is already submitted and has results'
            };
        }
        // A results-only step carries no query, so it has nothing to type and no
        // result to open.  The only action left would be submitting whatever
        // happens to be in the box, which is not what was asked for.
        if (!intent.query) {
            return { reason: 'no readable first result to open' };
        }
        return {
            actions: [
                { type: 'keypress', target: '', args: { key: 'Enter' } },
                { type: 'done', target: '', args: {} }
            ],
            reason: 'submitted the search query'
        };
    }

    /** What a search goal is asking for: the query, and whether to open a result. */
    _searchIntent(goal) {
        const value = String(goal || '');
        const openFirst = /\b(?:open|click|visit|go\s+to|select)\b[^.]{0,40}?\b(?:first|top)\b|\b(?:first|top)\b[^.]{0,24}?\b(?:result|page|link|hit|entry)\b/i.test(value);
        // A goal is split into clauses, so "open the first result" arrives
        // without the word "search" that introduced it.  It is still a search
        // step, and _planSearch additionally requires a real search control on
        // the page before it will act on that reading.
        const namesSearch = /\b(?:search|google|bing|find)\b/i.test(value);
        if (!namesSearch && !openFirst) return null;

        const quoted = value.match(/["']([^"']{1,200})["']/);
        let query = quoted ? quoted[1] : '';
        if (!query) {
            // The engine word is a separate word from the preposition, so it has to
        // be allowed for on its own.  Without it, "search google for cpp
        // tutorial" matched on "search", failed to match "for" next, and
        // captured "google for cpp tutorial" as the query.
        const after = value.match(new RegExp(
            `\\b(?:search(?:\\s+(?:on|using|via|with))?|${SEARCH_ENGINE_PATTERN}|find)\\b` +
            `[^a-z0-9]{0,12}` +
            `(?:${SEARCH_ENGINE_PATTERN}\\b[^a-z0-9]{0,12})?` +
            `(?:for\\s+|about\\s+)?` +
            `(.+?)(?=\\s+(?:and|then|open|click|visit|select|go)\\b|[?.!]|$)`, 'i'));
            query = after ? after[1] : '';
        }
        query = String(query || '').replace(/\s+/g, ' ').trim();
        // "open the first result" alone carries no query; the box supplies it.
        if (!query && !openFirst) return null;
        if (/^(?:the\s+)?(?:first|top)\s*(?:result|page|link|hit|entry)$/i.test(query)) query = '';
        if (query.length > 200) return null;
        return { query, openFirst };
    }

    /** The visible text currently held by an editable control. */
    _fieldText(node) {
        return String(node?.text || '').replace(/\s+/g, ' ').trim();
    }

    /**
     * The page's search control, or null when there is none or it is ambiguous.
     *
     * `_isOrdinaryEditable` already refuses identity and password fields, so a
     * login form with a "search" word in its markup is still a login form and
     * is never a candidate here.
     */
    _findSearchField(nodes) {
        const candidates = (Array.isArray(nodes) ? nodes : [])
            .filter(node => this._isOrdinaryEditable(node))
            .map(node => {
            const haystack = this._haystack(node);
            const role = String(node.role || '').toLowerCase();
            const inputType = String(node.inputType || '').toLowerCase();
            let score = 0;
            if (role === 'searchbox') score += 6;
            if (inputType === 'search') score += 6;
            if (String(node.autocomplete || '').toLowerCase() === 'search') score += 4;
            if (/\bsearch\b/.test(haystack)) score += 3;
            if (/\b(?:query|keyword)\b/.test(haystack)) score += 2;
            if (role === 'textbox' || inputType === 'text') score += 1;
            return { node, score };
        }).filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
        if (!candidates.length) return null;
        // A tie means two plausible search boxes; guessing could submit the
        // query to the wrong form.
        if (candidates[1] && candidates[0].score === candidates[1].score) return null;
        return candidates[0].node;
    }

    /**
     * The topmost link that reads as a result rather than page furniture.
     *
     * href is never collected, so results cannot be recognised by URL.  Two
     * structural things separate them instead: a result sits below the search
     * control and carries a descriptive title, while a menu, footer or tab is
     * labelled with a word or two wherever it sits.  Anything ambiguous is
     * refused rather than guessed, because opening the wrong link is worse
     * than escalating.
     */
    _firstResultLink(nodes, field, query) {
        const list = Array.isArray(nodes) ? nodes : [];
        const wanted = String(query || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const fieldBottom = Number(field?.bbox?.y || 0) + Number(field?.bbox?.height || 0);

        const links = list.filter(node => {
            if (!node || node.visible === false || node.enabled === false) return false;
            const tag = String(node.tag || '').toLowerCase();
            const role = String(node.role || '').toLowerCase();
            if (tag !== 'a' && role !== 'link') return false;
            const text = this._fieldText(node);
            if (text.length < 3) return false;
            // The query echoed back by the page is not a result.
            if (wanted && (text.toLowerCase() === wanted || text.toLowerCase().startsWith(`${wanted} `))) return false;
            return true;
        });
        if (!links.length) return { status: 'none', node: null };

        const results = links
            // Results appear below the query box, never beside or above it.
            .filter(node => Number(node.bbox?.y || 0) >= fieldBottom)
            // A short label is a menu, footer or tab rather than a result title.
            // A page whose only links below the query box are short ones has no
            // result list to open, and saying so is safer than clicking one.
            .filter(node => this._fieldText(node).length > DESCRIPTIVE_LINK_TEXT)
            .sort((a, b) => Number(a.bbox?.y || 0) - Number(b.bbox?.y || 0) ||
                Number(a.bbox?.x || 0) - Number(b.bbox?.x || 0));
        if (!results.length) return { status: 'none', node: null };

        const best = results[0];
        const runnerUp = results[1];
        // Two links on the same line means a layout this cannot read, such as a
        // two-column result grid.  Refuse instead of picking one.
        if (runnerUp && Math.abs(Number(runnerUp.bbox?.y || 0) - Number(best.bbox?.y || 0)) <= 8) {
            return { status: 'ambiguous', node: null };
        }
        return { status: 'ok', node: best };
    }

    _planTaskCreate(goal, nodes) {
        const value = String(goal || '');
        const hasTaskNoun = /\b(?:task|todo|to-do|reminder)\b/i.test(value);
        const hasImplicitQuotedCreate = /^\s*(?:please\s+)?(?:a\s+|an\s+)?(?:task|todo|to-do|reminder)\s*(?:(?:named|called|titled)\s+)?["'][^"']{1,200}["']\s*[.!?]?\s*$/i.test(value);
        const hasCreateVerb = /\b(?:add|create|new|make|write)\b/i.test(value) || hasImplicitQuotedCreate;
        const hasQuotedText = /["'][^"']{1,200}["']/.test(value);
        if (!hasTaskNoun || !hasCreateVerb || !hasQuotedText && !/\b(?:named|called|titled)\b/i.test(value)) return null;
        const text = this._requestedTaskText(goal);
        if (!text) return null;

        const editable = nodes.filter(node =>
            this._isOrdinaryEditable(node) && this._isTaskFieldCandidate(node)
        );
        const ranked = editable
            .map(node => ({ node, score: this._editableScore(node, goal) }))
            .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
        const positiveFields = ranked.filter(item => item.score > 0);
        const likelyFields = ranked.filter(item => this._isLikelyTaskComposer(item.node));
        const candidates = positiveFields.length ? positiveFields : likelyFields;
        const editor = candidates.length &&
            (!candidates[1] || candidates[0].score > candidates[1].score)
            ? candidates[0].node
            : null;
        const buttons = nodes.filter(node => this._isButton(node));
        const addButton = this._findTaskButton(buttons, ['add', 'new', 'create']);
        const submitButton = this._findTaskButton(buttons, ['add', 'create', 'save', 'submit', 'confirm', 'done']);
        const alreadyVisible = this._textIsVisibleAsContent(nodes, text);

        if (alreadyVisible) {
            return {
                actions: [{ type: 'done', target: '', args: {} }],
                reason: 'requested task text is already present'
            };
        }

        if (!editor) {
            if (addButton) {
                return {
                    actions: [{ type: 'click', target: addButton.id, args: {} }],
                    reason: 'opened the dynamic task composer'
                };
            }
            return { reason: 'task editor is not visible yet' };
        }

        const editorHasText = this._containsText(editor, text) ||
            String(editor.text || '').trim().toLowerCase() === normalize(text);
        if (!editorHasText) {
            return {
                actions: [
                    { type: 'focus', target: editor.id, args: {} },
                    { type: 'type_local', target: editor.id, args: { text } }
                ],
                reason: 'entered the task title in the visible editor'
            };
        }

        if (submitButton) {
            return {
                actions: [{ type: 'click', target: submitButton.id, args: {} }],
                reason: 'submitted the visible task editor'
            };
        }
        return {
            actions: [{ type: 'keypress', target: '', args: { key: 'Enter' } }],
            reason: 'submitted the task editor with Enter'
        };
    }

    _requestedTaskText(goal) {
        const value = String(goal || '');
        const quoted = value.match(/["']([^"']{1,200})["']/);
        if (quoted) return quoted[1].trim();
        const named = value.match(/\b(?:named|called|titled)\s+(?:the\s+)?(.+?)(?=\s+(?:and|then|by|using|with)\s+|$)/i);
        if (named) return stripQuotes(named[1]).trim();
        const after = value.match(/\b(?:add|create|new|make|write)\s+(?:a\s+|an\s+)?(?:task|todo|to-do|reminder)(?:\s+(?:named|called|titled))?\s+(.+)$/i);
        if (after) {
            const text = stripQuotes(after[1]).trim();
            if (text && !/^(?:click|save|submit)$/i.test(text)) return text;
        }
        return null;
    }

    _isIdentityField(node) {
        const type = String(node.inputType || '').toLowerCase();
        const autocomplete = String(node.autocomplete || '').toLowerCase();
        const identity = [
            node.id,
            node.name,
            node.ariaLabel,
            node.label,
            node.placeholder,
            node.title,
            node.testId
        ].filter(Boolean).join(' ').toLowerCase();
        return ['email', 'password', 'tel', 'url'].includes(type) ||
            ['email', 'username', 'tel', 'search', 'current-password', 'new-password'].includes(autocomplete) ||
            /\b(?:e[-\s]?mail|username|user\s*name|user\s*id|account|login|log\s*in|sign\s*in|password|passwd|pwd|credential|phone|telephone)\b/.test(identity);
    }

    _isTaskFieldCandidate(node) {
        const tag = String(node.tag || '').toLowerCase();
        const role = String(node.role || '').toLowerCase();
        const type = String(node.inputType || '').toLowerCase();
        const haystack = this._haystack(node);
        if (this._isIdentityField(node) ||
            /\b(?:search|filter|find)\b/.test(haystack)) return false;
        if (['input', 'textarea'].includes(tag) || type === 'contenteditable') return true;
        return ['textbox', 'combobox'].includes(role) &&
            /\b(?:task|todo|to-do|description|title|what\s+needs)\b/.test(haystack);
    }

    _isLikelyTaskComposer(node) {
        if (!this._isTaskFieldCandidate(node)) return false;
        const tag = String(node.tag || '').toLowerCase();
        const type = String(node.inputType || '').toLowerCase();
        const role = String(node.role || '').toLowerCase();
        if (/\b(?:task|todo|to-do|description|title|what\s+needs)\b/.test(this._haystack(node))) return true;
        return type === 'contenteditable' || tag === 'textarea' ||
            ['textbox', 'combobox'].includes(role);
    }

    _editableScore(node, goal) {
        const haystack = this._haystack(node);
        let score = 0;
        if (/\b(?:task|todo|note|memo|title|name)\b/.test(haystack)) score += 5;
        if (String(node.inputType || '').toLowerCase() === 'contenteditable') score += 4;
        if (['textbox', 'searchbox', 'combobox'].includes(String(node.role || '').toLowerCase())) score += 3;
        if (String(node.tag || '').toLowerCase() === 'textarea') score += 2;
        if (/\b(?:search|filter|find)\b/.test(haystack)) score -= 4;
        if (normalize(goal).includes(normalize(node.placeholder || '')) && node.placeholder) score += 2;
        return score;
    }

    _findTaskButton(buttons, words) {
        const scored = buttons.map(node => {
            const haystack = this._haystack(node);
            let score = 0;
            for (const word of words) {
                if (haystack.includes(word)) score += 3;
            }
            if (/\b(?:task|todo|note|memo)\b/.test(haystack)) score += 2;
            return { node, score };
        }).filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
        if (!scored.length || (scored[1] && scored[0].score === scored[1].score)) return null;
        return scored[0].node;
    }

    _containsText(node, expected) {
        const wanted = normalize(expected);
        if (!wanted) return false;
        return this._labels(node).some(label => normalize(label).includes(wanted));
    }

    /**
     * True when the requested text is already on the page as visible content.
     *
     * Deliberately narrower than _containsText.  An id, test id or title can
     * contain the requested text while nothing was ever created, and hidden
     * nodes are not evidence either.  Claiming completion on that basis ends
     * the run without accomplishing anything, so the evidence here is limited
     * to what the loop's completion verifier will actually accept.
     */
    _textIsVisibleAsContent(nodes, text) {
        const wanted = normalize(text);
        if (!wanted) return false;
        return (Array.isArray(nodes) ? nodes : []).some(node => {
            if (!node || node.visible === false) return false;
            if (this._isEditable(node)) return false;
            const role = String(node.role || '').toLowerCase();
            if (['textbox', 'searchbox', 'combobox'].includes(role)) return false;
            return [node.text, node.ariaLabel, node.label, node.placeholder, node.name]
                .filter(Boolean)
                .some(label => normalize(label).includes(wanted));
        });
    }

    _planSecretType(goal, nodes) {
        const intoMatch = goal.match(/^(?:please\s+)?(?:type|enter|fill|use)\s+(?:my\s+)?(email|username|phone|password)\s+(?:into|in|on)\s+(?:the\s+)?(.+?)(?:\s+field|\s+input)?$/i);
        const fillMatch = goal.match(/^(?:please\s+)?(?:fill|use)\s+(?:the\s+)?(.+?)(?:\s+field|\s+input)?\s+with\s+my\s+(email|username|phone|password)$/i);
        if (!intoMatch && !fillMatch) return null;

        const ref = String(intoMatch ? intoMatch[1] : fillMatch[2]).toLowerCase();
        const targetPhrase = intoMatch ? intoMatch[2] : fillMatch[1];
        const target = this._findNamedNode(nodes, targetPhrase, node => this._isEditable(node));
        if (!target) {
            return { reason: this._ambiguityReason(nodes, targetPhrase, node => this._isEditable(node)) };
        }
        if (this._isPasswordNode(target) && ref !== 'password') {
            return this._server('secret reference does not match target field');
        }
        return {
            actions: [
                { type: 'type_local', target: target.id, args: { secret_ref: ref } },
                { type: 'done', target: '', args: {} }
            ],
            reason: 'matched named field to a local secret reference'
        };
    }

    _planOrdinaryType(goal, nodes) {
        let body = goal.replace(/^(?:please\s+)?(?:type|enter|write|fill)\s+/i, '');
        if (!body || normalize(body) === normalize(goal)) return null;

        const into = findConnectorOutsideQuotes(body, ['into', 'in', 'on']);
        let textValue;
        let targetPhrase;
        if (into) {
            textValue = body.slice(0, into.index);
            targetPhrase = body.slice(into.index + into.length);
        } else {
            const fill = body.match(/^(?:the\s+)?(.+?)\s+with\s+(.+)$/i);
            if (!fill) return null;
            targetPhrase = fill[1];
            textValue = fill[2];
        }

        textValue = stripQuotes(textValue);
        targetPhrase = stripQuotes(targetPhrase);
        if (!textValue || textValue.length > 200) return null;
        if (/\b(?:password|passwd|secret|token|api[_ -]?key|private[_ -]?key)\b/i.test(textValue) ||
            SENSITIVE_TEXT_PATTERNS.some(pattern => pattern.test(textValue))) {
            return {
                ...this._server('local typing contains a sensitive literal'),
                blockEscalation: true
            };
        }

        const target = this._findNamedNode(nodes, targetPhrase, node => this._isOrdinaryEditable(node));
        if (!target) {
            return { reason: this._ambiguityReason(nodes, targetPhrase, node => this._isOrdinaryEditable(node)) };
        }
        return {
            actions: [
                { type: 'type_local', target: target.id, args: { text: textValue } },
                { type: 'done', target: '', args: {} }
            ],
            reason: 'matched exact editable field for ordinary local text'
        };
    }

    _planLogin(goal, nodes) {
        if (!/^(?:please\s+)?(?:log\s*in|login|sign\s*in|signin)$/i.test(goal)) return null;

        const fields = nodes.filter(node => this._isEditable(node));
        const identity = fields.filter(node => {
            const haystack = this._haystack(node);
            return /email|username|user\s*name/.test(haystack);
        });
        const password = fields.filter(node => this._isPasswordNode(node));

        if (identity.length !== 1 || password.length > 1) {
            return { reason: 'login fields are ambiguous' };
        }

        const anchors = [...identity, ...password];
        const band = this._fieldBand(anchors);
        // A submit control is often an unlabelled icon button, so requiring a
        // "log in"-style label would discard the only control that submits the
        // form.  Admit unlabelled form controls that sit at or below the
        // credential fields as weaker candidates.
        const buttons = nodes.filter(node => {
            if (!this._isButton(node)) return false;
            if (/\b(log\s*in|login|sign\s*in|signin|submit|continue)\b/.test(this._haystack(node))) return true;
            return this._isPlausibleUnlabelledSubmit(node, band);
        });

        const button = this._pickLoginSubmit(buttons, anchors);
        if (!button) {
            return { reason: 'login submit control is ambiguous' };
        }
        const identityHasValue = Boolean(String(identity[0].text || '').trim());
        const passwordHasValue = password.length === 1 && Boolean(String(password[0].text || '').trim());
        const actions = [];
        if (!identityHasValue) {
            actions.push({
                type: 'type_local',
                target: identity[0].id,
                args: { secret_ref: /username|user\s*name/.test(this._haystack(identity[0])) ? 'username' : 'email' }
            });
        }
        if (password.length === 1 && !passwordHasValue) {
            actions.push({ type: 'type_local', target: password[0].id, args: { secret_ref: 'password' } });
        }
        actions.push(
            { type: 'click', target: button.id, args: {} },
            { type: 'done', target: '', args: {} }
        );
        return {
            actions,
            reason: identityHasValue && (!password.length || passwordHasValue)
                ? 'matched an already-filled local login form'
                : 'matched exact local login form'
        };
    }

    /**
     * Choose the control that submits the login form.
     *
     * Real login pages almost always contain more than one control labelled
     * "Log in": a header navigation link and the form's submit button.  They
     * are told apart generically, without any site-specific selector, by
     * control type (a link navigates, a button submits) and by geometry (the
     * submit control sits beside the credential fields).  A tie stays
     * ambiguous rather than guessing.
     */
    _pickLoginSubmit(buttons, fields) {
        if (!buttons.length) return null;
        if (buttons.length === 1) return buttons[0];

        const ranked = buttons
            .map(node => ({ node, score: this._loginSubmitScore(node, fields) }))
            .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
        const best = ranked[0];
        if (ranked.length > 1 && best.score <= ranked[1].score) return null;
        return best.node;
    }

    /**
     * The vertical and horizontal extent covered by the credential fields.
     * Used to tell a form's own controls from the alternative sign-in
     * providers that sit above them.
     */
    _fieldBand(fields) {
        let top = null;
        let bottom = null;
        let left = null;
        let right = null;
        for (const field of fields || []) {
            const box = field?.bbox;
            if (!box || typeof box.y !== 'number') continue;
            const height = typeof box.height === 'number' ? box.height : 0;
            const width = typeof box.width === 'number' ? box.width : 0;
            top = top === null ? box.y : Math.min(top, box.y);
            bottom = bottom === null ? box.y + height : Math.max(bottom, box.y + height);
            left = left === null ? box.x : Math.min(left, box.x);
            right = right === null ? box.x + width : Math.max(right, box.x + width);
        }
        return top === null ? null : { top, bottom, left, right };
    }

    /**
     * The label a user or assistive technology would actually perceive.  This
     * deliberately excludes the element id, which is often an opaque hash and
     * would otherwise make every control look like it carries a name.
     */
    _accessibilityLabel(node) {
        return [
            node.text,
            node.placeholder,
            node.ariaLabel,
            node.label,
            node.name,
            node.title,
            node.testId
        ].filter(Boolean).join(' ').trim();
    }

    /**
     * An unlabelled button can still be the form's submit control.  It is only
     * plausible when it is a real form control and is not part of the
     * alternative-auth region stacked above the first credential field.
     */
    _isPlausibleUnlabelledSubmit(node, band) {
        const tag = String(node.tag || '').toLowerCase();
        const role = String(node.role || '').toLowerCase();
        const inputType = String(node.inputType || '').toLowerCase();
        if (inputType === 'submit') return true;
        if (tag === 'a' || role === 'link') return false;
        if (tag !== 'button' && role !== 'button') return false;
        if (this._accessibilityLabel(node)) return false;
        const box = node.bbox;
        if (!box || typeof box.y !== 'number' || !band) return false;
        const boxBottom = box.y + (typeof box.height === 'number' ? box.height : 0);
        return boxBottom > band.top;
    }

    _loginSubmitScore(node, fields) {
        const tag = String(node.tag || '').toLowerCase();
        const role = String(node.role || '').toLowerCase();
        const inputType = String(node.inputType || '').toLowerCase();
        const haystack = this._haystack(node);
        let score = 1;

        // A form control submits; a navigation link only navigates.  Prefer the
        // former, and only accept a link when nothing else is available.
        if (tag === 'button' || role === 'button' || inputType === 'submit') score += 4;
        else if (tag === 'a' || role === 'link') score -= 4;

        if (/\b(?:submit|sign\s*in|log\s*in|login|continue)\b/.test(haystack)) score += 2;

        // "Continue with Google" / "Log in with Apple" open a federated sign-in
        // provider rather than submitting the credential form on this page.
        if (/\b(?:continue|log\s*in|login|sign\s*in|sign\s*up|register)\s+with\b/.test(haystack)) {
            score -= 6;
        }

        // Proximity to the credential fields, graded continuously so the two
        // nearest controls are separable: a header link sits far from the
        // inputs, and the submit button sits directly below them.
        const box = node.bbox;
        if (box && typeof box.y === 'number') {
            const nearest = this._nearestFieldDistance(box, fields);
            if (nearest !== null) score += Math.max(-3, 4 - nearest / 120);
        }

        // Direction matters as much as distance.  A form's own submit sits
        // after the last field, while "Continue with Google" and "Sign in with
        // Apple" are stacked above the first one.  Treating both directions
        // equally let whichever provider happened to sit nearest win.
        const band = this._fieldBand(fields);
        if (band && box && typeof box.y === 'number') {
            const boxBottom = box.y + (typeof box.height === 'number' ? box.height : 0);
            if (box.y >= band.bottom) score += 3;
            else if (boxBottom <= band.top) score -= 3;
        }
        return score;
    }

    _nearestFieldDistance(box, fields) {
        let nearest = null;
        for (const field of fields || []) {
            const other = field?.bbox;
            if (!other || typeof other.y !== 'number' || typeof other.height !== 'number') continue;
            const fieldBottom = other.y + other.height;
            const gap = box.y >= fieldBottom
                ? box.y - fieldBottom
                : other.y >= box.y + box.height
                    ? other.y - (box.y + box.height)
                    : 0;
            if (nearest === null || gap < nearest) nearest = gap;
        }
        return nearest;
    }

    _findNamedNode(nodes, phrase, predicate) {
        const candidates = [phrase, this._stripGenericName(phrase)]
            .map(value => String(value || '').trim())
            .filter(Boolean);
        const filtered = nodes.filter(node => predicate(node));
        for (const candidate of candidates) {
            const resolution = resolveTarget(candidate, filtered, null, { actionType: null });
            if (resolution.status === 'resolved' && resolution.node) return resolution.node;
        }
        return null;
    }

    _ambiguityReason(nodes, phrase, predicate) {
        const candidates = [phrase, this._stripGenericName(phrase)]
            .map(value => String(value || '').trim())
            .filter(Boolean);
        const filtered = nodes.filter(node => predicate(node));
        for (const candidate of candidates) {
            const resolution = resolveTarget(candidate, filtered, null, { actionType: null });
            if (resolution.status === 'ambiguous') return 'local target is ambiguous';
        }
        return 'no exact visible local target matched';
    }

    _stripGenericName(phrase) {
        let value = String(phrase || '').trim();
        value = value.replace(/^(?:the|a|an)\s+/i, '');
        value = value.replace(/\s+(?:button|link|menu|field|input|control)$/i, '');
        return value.replace(/[.!?]+$/, '').trim();
    }

    _labels(node) {
        return [
            node.text,
            node.placeholder,
            node.ariaLabel,
            node.label,
            node.name,
            node.title,
            node.testId,
            node.id
        ].filter(Boolean);
    }

    _haystack(node) {
        return this._labels(node).join(' ').toLowerCase();
    }

    _isButton(node) {
        return ['button', 'a'].includes(String(node.tag || '').toLowerCase()) ||
            ['button', 'link', 'menuitem', 'tab', 'checkbox', 'switch', 'radio', 'option', 'treeitem']
                .includes(String(node.role || '').toLowerCase());
    }

    _isLinkOrMenu(node) {
        const tag = String(node.tag || '').toLowerCase();
        const role = String(node.role || '').toLowerCase();
        return tag === 'a' || role === 'link' || role === 'menuitem' ||
            (this._isButton(node) && node.getAttribute?.('aria-haspopup'));
    }

    /**
     * A control that can actually hold typed text.
     *
     * A submit button, a hidden field and a file picker are all input
     * elements, but none of them can receive typed text, and the content
     * script already refuses to type into any of them.  Counting them as
     * editable here made a hidden <input name="email"> read as a second
     * credential field, so a login was reported ambiguous and the agent
     * stalled on the login page.  This mirrors the content script's rule
     * rather than inventing a new one.
     */
    _isEditable(node) {
        const tag = String(node.tag || '').toLowerCase();
        if (tag === 'textarea') return true;
        if (String(node.inputType || '').toLowerCase() === 'contenteditable') return true;
        if (tag !== 'input') return false;
        const type = String(node.inputType || '').toLowerCase() || 'text';
        return TEXT_ENTRY_INPUT_TYPES.has(type);
    }

    _isOrdinaryEditable(node) {
        return this._isEditable(node) &&
            !this._isIdentityField(node) &&
            !this._isPasswordNode(node) &&
            node.readOnly !== true;
    }

    _isPasswordNode(node) {
        const haystack = this._haystack(node);
        return String(node.inputType || '').toLowerCase() === 'password' ||
            /current-password|new-password|password|passwd|pwd/.test(haystack);
    }
}
