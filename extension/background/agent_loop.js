import { Logger } from '../shared/logger.js';
import { Config } from '../shared/config.js';
import { APIClient, validateActionPlan } from './api_client.js';
import { LocalAgent } from './local_agent.js';
import { LocalVisionAgent } from './local_vision_agent.js';
import { LocalVisionRuntime } from './local_vision_runtime.js';
import { Redactor } from '../privacy/redactor.js';
import {
    resolveActionTarget,
    descriptorForNode,
    safeCandidateSummary
} from './action_grounding.js';

const logger = new Logger('AgentLoop');

const MAX_ACTIONS_PER_PLAN = 12;
const MAX_WAIT_ACTIONS = 3;
const MAX_TOTAL_WAIT_MS = 10000;
const MAX_CONSECUTIVE_WAITS = 2;
const MAX_ACTION_ATTEMPTS = 2;
const MAX_CYCLES = 20;
const BACKOFF_BASE_MS = 500;
const ACTION_SETTLE_MS = 150;
const TARGET_POLL_DELAYS_MS = [100, 200, 300, 450];
const MESSAGE_CONFIRMATION_DELAYS_MS = [100, 200, 400, 800];
const MAX_MESSAGE_CONFIRMATION_POLLS = MESSAGE_CONFIRMATION_DELAYS_MS.length + 1;
const MAX_MESSAGE_DRAFT_POLLS = 4;
const TASK_DISCOVERY_DELAYS_MS = [200, 350, 500, 750, 1000, 1500, 2000];
const MAX_TASK_DISCOVERY_POLLS = TASK_DISCOVERY_DELAYS_MS.length;
// A navigation replaces the document and detaches the content script, so a
// message that was fine one cycle earlier is refused mid-run.  Wait in place
// for the new document to attach instead of failing the run, but keep the
// wait bounded so a tab that can never be reached still reports the error.
const PAGE_LOAD_DELAYS_MS = [100, 200, 300, 500, 750, 1000, 1500, 2000, 2500];
const MAX_PAGE_LOAD_POLLS = PAGE_LOAD_DELAYS_MS.length;
// A heavy single page app can take several seconds to attach its content
// script after the document is replaced.  While the tab still reports itself
// as loading, keep waiting past the first bound instead of failing a run that
// was about to succeed.
const MAX_PAGE_LOAD_LINGER_MS = 15000;
// An unavailable backend cannot be repaired by waiting on it.  Give up after a
// few consecutive failures and report an actionable error instead of consuming
// the whole cycle budget on non-meaningful waits.
const MAX_CONSECUTIVE_BACKEND_FAILURES = 3;

export class AgentLoop {
    constructor(tabId, goal = '', options = {}) {
        this.goal = goal;
        this.tabId = tabId;
        this.client = new APIClient(Config.backendUrl, Config.apiTimeoutMs, { debugMode: Config.debugMode });
        this.localAgent = options.localAgent || new LocalAgent();
        this.localVisionAgent = options.localVisionAgent || new LocalVisionAgent({
            runtime: options.localVisionRuntime || new LocalVisionRuntime(Config.localVisionTimeoutMs)
        });
        this.cycleCount = 0;
        this.lastActions = [];
        this.running = false;
        this._generation = 0;
        this._actionRevision = 0;
        this._lastCycleFailed = false;
        this._lastSuccessfulPlanKey = null;
        this._lastSuccessfulObservationKey = null;
        this._executedCreateKeys = new Set();
        this._pendingPlan = null;
        this._recentActionAttempts = new Map();
        this._failedPlans = new Set();
        this._waitBudget = { actions: 0, totalMs: 0, consecutive: 0 };
        this._messageState = null;
        this._taskDiscoveryPolls = 0;
        this._localRoute = '';
        this._totalMeaningfulActionsExecuted = 0;
        this._consecutiveBackendFailures = 0;
        this._lastBackendError = '';
        this._scheduledTimer = null;
        // Starts true so a page that simply has no controls is never mistaken
        // for a page swap; only a refused message clears it.
        this._lastMessageDelivered = true;
        this._redactor = new Redactor();
        this._onMessageSubmitted = typeof options.onMessageSubmitted === 'function' ? options.onMessageSubmitted : () => {};
        this._onMessageConfirmed = typeof options.onMessageConfirmed === 'function' ? options.onMessageConfirmed : () => {};
        this._onMessageUnconfirmed = typeof options.onMessageUnconfirmed === 'function' ? options.onMessageUnconfirmed : () => {};
        this.debugActions = options.debugActions === true;
    }

    async start() {
        this.running = true;
        this.cycleCount = 0;
        this.lastActions = [];
        this._lastSuccessfulPlanKey = null;
        this._lastSuccessfulObservationKey = null;
        this._executedCreateKeys.clear();
        this._pendingPlan = null;
        this._recentActionAttempts.clear();
        this._failedPlans.clear();
        this._waitBudget = { actions: 0, totalMs: 0, consecutive: 0 };
        this._messageState = null;
        this._taskDiscoveryPolls = 0;
        this._localRoute = '';
        this._totalMeaningfulActionsExecuted = 0;
        this._consecutiveBackendFailures = 0;
        this._lastBackendError = '';
        this._clearScheduledCycle();
        this._generation += 1;
        const gen = this._generation;
        logger.info('Agent loop started');
        await this._cycle(gen);
    }

    stop() {
        if (this._messageState?.phase === 'submitted') {
            this._notifyMessage('unconfirmed', {
                text: this._messageState.text,
                method: this._messageState.method || 'send action'
            });
        }
        this.running = false;
        this._clearScheduledCycle();
        this._pendingPlan = null;
        this._messageState = null;
        this._generation += 1; // invalidate an in-flight observation/request
        void this.localVisionAgent?.dispose?.();
        logger.info('Agent loop stopped');
    }

    /** Continue after navigation without resetting the cycle budget entirely. */
    continueAfterNavigation() {
        if (!this.running) return;
        this.lastActions = [];
        this._lastSuccessfulPlanKey = null;
        this._lastSuccessfulObservationKey = null;
        this._pendingPlan = null;
        this._recentActionAttempts.clear();
        this._failedPlans.clear();
        this._waitBudget = { actions: 0, totalMs: 0, consecutive: 0 };
        // Preserve a typed/submitted message state across navigation. Resetting
        // it here could make a successful send look like a fresh task and cause
        // a duplicate after a page transition.
        this._taskDiscoveryPolls = 0;
        this._localRoute = '';
        this._clearScheduledCycle();
        this._generation += 1;
        const gen = this._generation;
        logger.info('Page navigated — resuming agent loop');
        this._scheduleNextCycle(gen, 800);
    }

    /**
     * One cycle observes the current page, accepts at most one bounded plan,
     * and executes at most one action.  A pending plan is deliberately kept
     * between cycles so every next target is resolved against a new DOM.
     */
    async _cycle(gen) {
        if (gen !== this._generation) return;
        if (!this.running || this.cycleCount >= MAX_CYCLES) {
            if (this._messageState?.phase === 'submitted') {
                this._notifyMessage('unconfirmed', {
                    text: this._messageState.text,
                    method: this._messageState.method || 'send action'
                });
                this._messageState = null;
            }
            logger.info(`Loop ended after ${this.cycleCount} cycles`);
            this.running = false;
            const incomplete = !!this._pendingPlan;
            const noAction = this._totalMeaningfulActionsExecuted === 0;
            const status = this._lastCycleFailed || incomplete || noAction ? 'error' : 'done';
            this._broadcast({
                type: 'AGENT_UPDATE',
                status,
                error: status === 'error'
                    ? (noAction
                        ? 'No action was executed; the requested task was not completed.'
                        : incomplete
                            ? 'Maximum action retries reached with an incomplete plan'
                            : 'Maximum action retries reached')
                    : undefined,
                cycle: this.cycleCount
            });
            this._pendingPlan = null;
            return;
        }

        this.cycleCount++;
        this._actionRevision += 1;
        this._lastCycleFailed = false;
        const traceId = this._newId();
        const timing = {};
        const t0 = performance.now();

        try {
            // Fresh local observation is mandatory before every plan action.
            // It is local-only and therefore does not invoke the privacy
            // pipeline or cross the server boundary.
            const localStart = performance.now();
            const localObservation = await this._sendToContent('ANALYZE_DOM', {});
            if (gen !== this._generation) return;
            if (!this._lastMessageDelivered) {
                // A refused message is the normal state of a tab that is
                // swapping documents, so wait for the new one to attach rather
                // than ending the run mid-navigation.
                if (await this._recoverFromPageSwap(gen) !== 'unavailable') return;
                this._fail('Content script not responding. Try reloading the page.', gen);
                return;
            }
            const localElements = Array.isArray(localObservation?.elements)
                ? localObservation.elements
                : [];
            this._localRoute = String(localObservation?.route || '');
            timing.localObservation = performance.now() - localStart;

            if (this._pendingPlan) {
                const handled = await this._executePendingPlan(localElements, gen, t0, timing);
                if (handled) return;
                if (gen !== this._generation) return;
            }

            // Once a message send has been attempted, never let a fresh plan
            // replay it while the conversation UI catches up. Confirmation is
            // bounded and deliberately fail-closed.
            if (this._handleMessageSubmissionState(localElements, gen)) return;

            // 0. LOCAL-FIRST deterministic planning.
            let deterministicDecision = null;
            if (localElements.length > 0) {
                const localContext = this._messageState?.phase === 'draft'
                    ? {
                        messageDraft: this._messageState.text,
                        messageDraftPolls: this._messageState.draftPolls || 0
                    }
                    : {};
                deterministicDecision = this.localAgent.analyze(this.goal, localElements, localContext);
                if (this._messageState?.phase === 'draft' &&
                    (deterministicDecision.decision !== 'LOCAL' ||
                        deterministicDecision.actions?.some(action => action.type === 'type_local'))) {
                    this._holdMessageDraft(gen);
                    return;
                }
                if (deterministicDecision.decision === 'SERVER' &&
                    this._isTaskMutationGoal() &&
                    /task editor is not visible yet/i.test(deterministicDecision.reason || '')) {
                    if (this._holdTaskDiscovery(gen)) return;
                }
                if (deterministicDecision.blockEscalation) {
                    this._fail('Goal contains sensitive input; request blocked locally.', gen);
                    return;
                }
                if (deterministicDecision.decision === 'LOCAL') {
                    this._taskDiscoveryPolls = 0;
                    this._broadcastRoute('local', 'running', deterministicDecision.reason || 'Local deterministic planner selected');
                    const queued = this._queuePlan(
                        deterministicDecision.actions,
                        localElements,
                        'local',
                        deterministicDecision
                    );
                    if (queued.accepted) {
                        const handled = await this._executePendingPlan(localElements, gen, t0, timing);
                        if (handled) return;
                    } else if (queued.blocked) {
                        return;
                    }
                }
            }

            // 0b. Local visual reasoning remains between deterministic DOM
            // planning and the existing privacy-gated server path.
            if (localElements.length > 0 &&
                typeof this.localVisionAgent?.shouldAttempt === 'function' &&
                this.localVisionAgent.shouldAttempt(this.goal, deterministicDecision || {})) {
                this._broadcastRoute('local-vision', 'running', 'Local screenshot model is analyzing the page');
                const visionStart = performance.now();
                try {
                    const visionObservation = await this._sendToContent('LOCAL_VISION_OBSERVE', {});
                    if (gen !== this._generation) return;
                    if (visionObservation && !visionObservation.error) {
                        const visionDecision = await this.localVisionAgent.analyze(
                            this.goal,
                            visionObservation
                        );
                        timing.localVision = performance.now() - visionStart;
                        if (visionDecision.localVisionUnavailable) {
                            this._broadcast({
                                type: 'AGENT_UPDATE',
                                log: 'LOCAL_VISION_UNAVAILABLE; escalating through the privacy gate',
                                logLevel: 'warn',
                                cycle: this.cycleCount,
                                localVision: visionDecision.metrics || {}
                            });
                        }
                        if (visionDecision.decision === 'LOCAL') {
                            this._broadcastRoute('local-vision', 'running', 'Local screenshot model selected an action');
                            const queued = this._queuePlan(
                                visionDecision.actions,
                                localElements,
                                'local-vision',
                                visionDecision
                            );
                            if (queued.accepted) {
                                const handled = await this._executePendingPlan(localElements, gen, t0, timing);
                                if (handled) return;
                            } else if (queued.blocked) {
                                return;
                            }
                        }
                    } else {
                        timing.localVision = performance.now() - visionStart;
                        this._broadcast({
                            type: 'AGENT_UPDATE',
                            log: 'LOCAL_VISION_UNAVAILABLE; escalating through the privacy gate',
                            logLevel: 'warn',
                            cycle: this.cycleCount
                        });
                    }
                } catch (_) {
                    if (gen !== this._generation) return;
                    timing.localVision = performance.now() - visionStart;
                    this._broadcast({
                        type: 'AGENT_UPDATE',
                        log: 'LOCAL_VISION_UNAVAILABLE; escalating through the privacy gate',
                        logLevel: 'warn',
                        cycle: this.cycleCount
                    });
                }
            }

            // 1. OBSERVE through the unchanged privacy pipeline only after
            // local reasoning abstains.
            this._broadcastRoute('privacy', 'running', 'Local PII/OCR privacy gate is preparing the sanitized context');
            const observeStart = performance.now();
            const observed = await this._sendToContent('PRIVACY_PIPELINE', {});
            if (gen !== this._generation) return;
            timing.observe = performance.now() - observeStart;
            if (!this._lastMessageDelivered) {
                if (await this._recoverFromPageSwap(gen) !== 'unavailable') return;
                this._fail('Content script not responding. Try reloading the page.', gen);
                return;
            }
            if (!observed) {
                this._fail('Privacy pipeline returned no sanitized context.', gen);
                return;
            }
            if (!observed.allowed) {
                this._fail('Privacy gate blocked: ' + (observed.violations || []).join(', '), gen);
                return;
            }
            if (!observed.sanitizedContext || typeof observed.sanitizedContext !== 'object') {
                this._fail('Privacy pipeline returned no sanitized context.', gen);
                return;
            }

            // 2. REASON using only the already-sanitized context.
            const networkStart = performance.now();
            observed.sanitizedContext.goal = this._redactor.redactText(this.goal || '');
            this._broadcastRoute('server', 'running', 'Backend server VLM is planning from sanitized context');
            const planResult = await this.client.plan(observed.sanitizedContext);
            if (gen !== this._generation) return;
            timing.network = performance.now() - networkStart;
            if (!planResult.success) {
                this._lastCycleFailed = true;
                this._consecutiveBackendFailures += 1;
                this._lastBackendError = String(planResult.error || 'Backend planner request failed');
                logger.warn('Backend plan failed', { error: this._lastBackendError });
                this._broadcast({
                    type: 'AGENT_UPDATE',
                    route: 'server',
                    model: 'server-provider',
                    modelStatus: 'error',
                    routeDetail: 'Backend planner request failed',
                    log: 'Backend error: ' + this._lastBackendError,
                    logLevel: 'error',
                    cycle: this.cycleCount
                });
                if (this._consecutiveBackendFailures >= MAX_CONSECUTIVE_BACKEND_FAILURES) {
                    this._fail(
                        'The configured planner backend is unavailable (' +
                        this._lastBackendError + '). ' +
                        'Local planning could not complete this action on its own, so no further steps were attempted.',
                        gen
                    );
                    return;
                }
                await this._backoff(gen);
                return;
            }
            this._consecutiveBackendFailures = 0;

            const actions = Array.isArray(planResult.actions) ? planResult.actions : [];
            this._broadcastRoute('server', 'running', 'Backend plan received; executing one validated action at a time');
            const observedDom = observed.sanitizedContext.dom || [];
            const queued = this._queuePlan(actions, observedDom, 'server', {
                reason: 'server plan'
            });
            if (queued.blocked) return;
            if (queued.accepted) {
                // Prefer the independent local observation for the immediate
                // target check.  The sanitized snapshot remains the source of
                // the plan/descriptor, while the raw snapshot is used only in
                // the browser to validate current visibility and identity.
                const executionDom = localElements.length > 0 ? localElements : observedDom;
                const handled = await this._executePendingPlan(executionDom, gen, t0, timing);
                if (handled) return;
                if (gen !== this._generation) return;
                this._lastCycleFailed = true;
                this._scheduleNextCycle(gen, BACKOFF_BASE_MS);
                return;
            }

            if (gen !== this._generation) return;
            this._lastCycleFailed = true;
            this._broadcast({
                type: 'AGENT_UPDATE',
                status: 'error',
                error: 'Planner returned no executable safe action',
                log: 'Planner response did not contain a usable action plan',
                logLevel: 'warn',
                cycle: this.cycleCount
            });
            await this._backoff(gen);
            return;
        } catch (e) {
            if (gen !== this._generation) return;
            this._lastCycleFailed = true;
            logger.error('Cycle error: ' + e.message);
            this._broadcast({
                type: 'AGENT_UPDATE',
                log: 'Cycle error: ' + e.message,
                logLevel: 'error',
                cycle: this.cycleCount
            });
            await this._backoff(gen);
        }
    }

    _queuePlan(actions, domElements, source, decision) {
        const validated = validateActionPlan(actions);
        if (!validated.ok || !validated.actions.length) {
            logger.warn('Plan rejected by shared validator', { reason: validated.error || 'empty plan' });
            return { accepted: false, blocked: false };
        }
        let plan = validated.actions.slice(0, MAX_ACTIONS_PER_PLAN);

        // Drop only the unsafe action instead of discarding the whole plan.
        // A plan that types task text into an email field is still a useful
        // plan for every other step (for example the preceding login actions);
        // rejecting it wholesale used to throw those away and stall the run.
        if (this._planHasUnsafeIdentityText(plan, domElements)) {
            const safe = plan.filter(action =>
                !this._isUnsafePasswordTextAction(action, domElements) &&
                !this._isUnsafeIdentityTextAction(action, domElements)
            );
            if (safe.length !== plan.length) {
                logger.warn('Dropped an unsafe identity-field text action from the plan');
                this._broadcast({
                    type: 'AGENT_UPDATE',
                    log: 'Blocked task text from being typed into an identity field; the remaining steps continue.',
                    logLevel: 'warn',
                    cycle: this.cycleCount
                });
            }
            plan = safe;
            // If filtering left nothing executable, there is no plan to run.
            if (!plan.some(action => action.type !== 'done')) {
                return { accepted: false, blocked: false };
            }
        }
        // Never route authentication to a third-party identity provider while
        // the page offers its own credential form.  This applies to backend
        // plans as well as local ones: the model will happily pick a visible
        // "Sign in with Apple" button, which cannot complete with the
        // credentials held locally.
        if (plan.some(action => this._isUnsafeFederatedClick(action, domElements))) {
            const safe = plan.filter(action => !this._isUnsafeFederatedClick(action, domElements));
            if (safe.length !== plan.length) {
                logger.warn('Dropped a federated sign-in click from the plan');
                this._broadcast({
                    type: 'AGENT_UPDATE',
                    log: 'Blocked a third-party sign-in button; the page has its own login form.',
                    logLevel: 'warn',
                    cycle: this.cycleCount
                });
            }
            plan = safe;
            if (!plan.some(action => action.type !== 'done')) {
                return { accepted: false, blocked: false };
            }
        }
        const executable = plan.filter(action => action.type !== 'done');
        if (plan.some(action => action.type === 'done') && executable.length > 0 &&
            executable.every(action => action.type === 'wait')) {
            return { accepted: false, blocked: false };
        }
        // A plan made only of waits can never accomplish a goal.  Executing one
        // used to burn the whole cycle budget while reporting a non-zero action
        // count, which made an unavailable backend look like progress.
        if (plan.every(action => action.type === 'wait')) {
            return { accepted: false, blocked: false };
        }
        const planKey = this._planKey(plan);
        const observationKey = this._observationKey({ dom: domElements, route: this._localRoute });
        if (source !== 'server' && this._shouldBlockRepeatedCreate(plan, domElements)) {
            this._stopDuplicateCreate();
            return { accepted: false, blocked: true };
        }
        if (this._failedPlans.has(`${planKey}|${observationKey}`)) {
            this.running = false;
            this._broadcast({
                type: 'AGENT_UPDATE',
                status: 'error',
                error: 'Plan could not establish its expected state; no action was executed.',
                log: 'Stopped after a plan could not establish its expected state.',
                logLevel: 'warn',
                cycle: this.cycleCount
            });
            return { accepted: false, blocked: true };
        }
        this._pendingPlan = {
            actions: plan,
            index: 0,
            source,
            decision: decision || {},
            planKey,
            observationKey,
            descriptors: plan.map(action => descriptorForNode(this._domNodeForAction(action, domElements))),
            actionsExecuted: 0,
            meaningfulActionsExecuted: 0,
            expectedText: this._expectedText(plan),
            mutation: this._isTaskMutationGoal() || this._isMessageMutationGoal()
        };
        return { accepted: true, blocked: false };
    }

    async _executePendingPlan(domElements, gen, cycleStart, timing) {
        const pending = this._pendingPlan;
        if (!pending) return false;
        if (gen !== this._generation || !this.running) return true;

        const action = pending.actions[pending.index];
        if (!action) {
            this._pendingPlan = null;
            return false;
        }

        if (action.type === 'done') {
            if (pending.meaningfulActionsExecuted === 0) {
                // A plan of only "done" is normally a planner mistake, and is
                // rejected so a stalled run cannot be reported as success.  But
                // when the requested outcome is already visible in the page the
                // planner is right and there is nothing left to do, so verify
                // the outcome instead of refusing it.  This is the final cycle
                // of a normal create flow: the task was added by the previous
                // plan and this plan merely reports that it is there.
                const expected = String(pending.expectedText || '').trim();
                if (expected && this._domContainsCompletedText(domElements, expected)) {
                    this._pendingPlan = null;
                    this.running = false;
                    this._broadcast({
                        type: 'AGENT_UPDATE',
                        source: pending.source,
                        status: 'done',
                        log: 'Requested result was already present and has been verified.',
                        cycle: this.cycleCount,
                        actionsExecuted: 0,
                        actions: this._safeActionsForBroadcast(pending.actions)
                    });
                    return true;
                }
                this._pendingPlan = null;
                this._lastCycleFailed = true;
                this.running = false;
                this._broadcast({
                    type: 'AGENT_UPDATE',
                    source: pending.source,
                    status: 'error',
                    error: 'Planner returned done without executing an action.',
                    log: 'Completion rejected because no action was executed.',
                    logLevel: 'warn',
                    cycle: this.cycleCount
                });
                return true;
            }
            const completion = await this._verifyCompletion(domElements, pending, gen);
            if (completion.complete) {
                this._pendingPlan = null;
                this.running = false;
                this._broadcast({
                    type: 'AGENT_UPDATE',
                    source: pending.source,
                    status: 'done',
                    log: pending.source === 'server'
                        ? 'Server plan completed and its postcondition was verified.'
                        : 'Local plan completed and its postcondition was verified.',
                    cycle: this.cycleCount,
                    actionsExecuted: pending.actionsExecuted,
                    actions: this._safeActionsForBroadcast(pending.actions)
                });
                return true;
            }
            this._lastCycleFailed = true;
            this._failedPlans.add(`${pending.planKey}|${this._observationKey({ dom: domElements, route: this._localRoute })}`);
            this._pendingPlan = null;
            logger.warn('Completion marker rejected because the expected state was not observed');
            return false;
        }

        if (action.type === 'wait' && this._isProviderErrorAction(action)) {
            this._pendingPlan = null;
            this.running = false;
            const error = action.args?.reason || 'Backend planner returned an error';
            this._broadcast({
                type: 'AGENT_UPDATE',
                source: pending.source,
                status: 'error',
                error,
                log: `Backend planner error: ${error}`,
                logLevel: 'error',
                cycle: this.cycleCount
            });
            return true;
        }

        let currentAction = action;
        let currentDom = domElements;
        if (!['wait', 'scroll'].includes(action.type) || action.type === 'scroll' && action.target) {
            const resolution = await this._resolveCurrentTarget(
                currentAction,
                pending.descriptors[pending.index],
                currentDom,
                gen
            );
            if (!resolution || resolution.status !== 'resolved') {
                if (this.debugActions) {
                    this._broadcast({
                        type: 'ACTION_DEBUG',
                        cycle: this.cycleCount,
                        action: { type: currentAction.type, target: this._debugTarget(currentAction.target) },
                        status: resolution?.status || 'not-found',
                        candidates: safeCandidateSummary(resolution)
                    });
                }
                this._pendingPlan = null;
                this._lastCycleFailed = true;
                logger.warn('Action target is stale or ambiguous; re-observing before replanning', {
                    type: action.type,
                    target: action.target
                });
                this._broadcast({
                    type: 'AGENT_UPDATE',
                    log: `Action target re-observed: ${action.type} was not executed; planning again`,
                    logLevel: 'warn',
                    cycle: this.cycleCount
                });
                return false;
            }
            currentDom = resolution.dom || currentDom;
            if (resolution.node && !['wait', 'done', 'scroll'].includes(currentAction.type)) {
                currentAction = { ...currentAction, target: String(resolution.node.id).replace(/^#/, '') };
            }
        }

        if (currentAction.type === 'wait') {
            const requestedMs = Number(currentAction.args?.ms);
            const waitMs = Number.isFinite(requestedMs)
                ? Math.max(50, Math.min(5000, Math.round(requestedMs)))
                : 500;
            if (this._waitBudget.actions >= MAX_WAIT_ACTIONS ||
                this._waitBudget.totalMs + waitMs > MAX_TOTAL_WAIT_MS ||
                this._waitBudget.consecutive >= MAX_CONSECUTIVE_WAITS) {
                this._pendingPlan = null;
                this.running = false;
                this._broadcast({
                    type: 'AGENT_UPDATE',
                    status: 'error',
                    error: 'Wait budget exceeded',
                    log: 'Action rejected: bounded wait budget exceeded',
                    logLevel: 'warn',
                    cycle: this.cycleCount
                });
                return true;
            }
            currentAction = { ...currentAction, args: { ...(currentAction.args || {}), ms: waitMs } };
        }

        const singleValidation = validateActionPlan([currentAction]);
        if (!singleValidation.ok) {
            this._pendingPlan = null;
            this.running = false;
            this._broadcast({
                type: 'AGENT_UPDATE',
                status: 'error',
                error: singleValidation.error,
                log: 'Action rejected by the shared validator',
                logLevel: 'error',
                cycle: this.cycleCount
            });
            return true;
        }
        currentAction = singleValidation.actions[0];

        if (this._messageState?.phase === 'draft' && currentAction.type === 'type_local') {
            this._pendingPlan = null;
            this._holdMessageDraft(gen);
            return true;
        }
        if (this._messageState?.phase === 'submitted' &&
            (currentAction.type === 'type_local' ||
                this._isMessageSubmissionAction(currentAction, currentDom))) {
            this._pendingPlan = null;
            this._handleMessageSubmissionState(currentDom, gen);
            return true;
        }

        if (this._isUnsafePasswordTextAction(currentAction, currentDom) ||
            this._isUnsafeIdentityTextAction(currentAction, currentDom)) {
            const passwordField = this._isUnsafePasswordTextAction(currentAction, currentDom);
            this._pendingPlan = null;
            this.running = false;
            this._broadcast({
                type: 'AGENT_UPDATE',
                status: 'error',
                error: passwordField
                    ? 'Plaintext text cannot be typed into a password field'
                    : 'Task text cannot be typed into an identity field',
                log: 'Action rejected: ordinary text was not allowed in a credential field',
                logLevel: 'error',
                cycle: this.cycleCount
            });
            return true;
        }

        const observationKey = this._observationKey({ dom: currentDom, route: this._localRoute });
        if (this._isDuplicate(currentAction, observationKey)) {
            this._pendingPlan = null;
            if (this._isCreateAction(currentAction, currentDom)) {
                this._stopDuplicateCreate();
            } else {
                this.running = false;
                this._broadcast({
                    type: 'AGENT_UPDATE',
                    status: 'error',
                    error: 'The page did not change after the action; the task was not completed.',
                    log: 'Stopped a repeated action after the page observation was unchanged.',
                    logLevel: 'warn',
                    cycle: this.cycleCount
                });
            }
            return true;
        }
        this._recordActionAttempt(currentAction, observationKey);

        const actionStart = performance.now();
        const result = await this._executeAction(currentAction, gen);
        timing.action = (timing.action || 0) + performance.now() - actionStart;
        if (gen !== this._generation) return true;
        if (!result || !result.success || result.verified === false) {
            if (!this._lastMessageDelivered) {
                // Nothing received the action, so it definitely did not run.
                // That is a document swap rather than a failed action, and
                // unlike a lost response there is no risk of a double click:
                // wait for the new page and plan the action again.
                if (await this._recoverFromPageSwap(gen) !== 'unavailable') return true;
                this._fail('Content script not responding. Try reloading the page.', gen);
                return true;
            }
            const stale = result && /element not found|target.*(missing|not present|stale)|invalid selector/i.test(result.error || '');
            this._pendingPlan = null;
            this._lastCycleFailed = true;
            if (!stale) {
                this.running = false;
                this._broadcast({
                    type: 'AGENT_UPDATE',
                    status: 'error',
                    error: result?.error || 'Action failed',
                    log: `Action failed: ${currentAction.type} → ${result?.error || 'no response'}`,
                    logLevel: 'error',
                    cycle: this.cycleCount
                });
                return true;
            }
            this._broadcast({
                type: 'AGENT_UPDATE',
                log: `Action target changed: ${currentAction.type} was not retried; re-observing`,
                logLevel: 'warn',
                cycle: this.cycleCount
            });
            return false;
        }

        this._recordMessageActionProgress(currentAction, currentDom, pending);
        pending.index += 1;
        pending.actionsExecuted += 1;
        if (currentAction.type === 'wait') {
            this._waitBudget.actions += 1;
            this._waitBudget.totalMs += Number(currentAction.args?.ms) || 0;
            this._waitBudget.consecutive += 1;
        } else {
            this._waitBudget.consecutive = 0;
            pending.meaningfulActionsExecuted += 1;
            this._totalMeaningfulActionsExecuted += 1;
        }
        this.lastActions.push({ revision: this._actionRevision, action: currentAction });
        if (this._isCreateAction(currentAction, currentDom)) {
            this._executedCreateKeys.add(this._createActionKey(currentAction, currentDom));
        }
        this._lastSuccessfulPlanKey = pending.planKey;
        this._lastSuccessfulObservationKey = pending.observationKey;

        if (this.debugActions) {
            this._broadcast({
                type: 'ACTION_DEBUG',
                cycle: this.cycleCount,
                action: { type: currentAction.type, target: this._debugTarget(currentAction.target) },
                verified: result.verified !== false,
                candidates: []
            });
        }

        // Re-observe immediately after the one executed action.  This is used
        // only to verify a terminal postcondition or to prepare the next
        // cycle; no second action is executed in this cycle.
        const after = await this._observeDom(gen);
        if (gen !== this._generation) return true;
        if (after.length === 0 && currentAction.type !== 'scroll') {
            // A missing response is not evidence of failure for a real SPA;
            // retain the queue and let the next bounded cycle re-observe.
            this._scheduleNextCycle(gen, ACTION_SETTLE_MS);
            return true;
        }
        if (pending.index < pending.actions.length && pending.actions[pending.index].type === 'done') {
            const completion = await this._verifyCompletion(after, pending, gen);
            if (completion.complete) {
                this._pendingPlan = null;
                this.running = false;
                this._broadcast({
                    type: 'AGENT_UPDATE',
                    source: pending.source,
                    status: 'done',
                    log: 'Post-action state verified; task complete.',
                    cycle: this.cycleCount,
                    actionsExecuted: pending.actionsExecuted,
                    actions: this._safeActionsForBroadcast(pending.actions)
                });
                return true;
            }
        }
        this._broadcast({
            type: 'AGENT_UPDATE',
            source: pending.source,
            cycle: this.cycleCount,
            timing,
            actionsExecuted: pending.actionsExecuted,
            actions: [this._safeActionsForBroadcast([currentAction])[0]],
            verified: result.verified !== false
        });
        this._scheduleNextCycle(gen, ACTION_SETTLE_MS);
        return true;
    }

    async _resolveCurrentTarget(action, descriptor, domElements, gen) {
        let current = Array.isArray(domElements) ? domElements : [];
        for (let attempt = 0; attempt <= TARGET_POLL_DELAYS_MS.length; attempt++) {
            if (gen !== this._generation) return null;
            let resolution = resolveActionTarget(action, current, descriptor);
            if (resolution.status === 'resolved') return { ...resolution, dom: current };
            if (attempt < TARGET_POLL_DELAYS_MS.length) {
                await this._sleep(TARGET_POLL_DELAYS_MS[attempt]);
                if (gen !== this._generation) return null;
                const next = await this._observeDom(gen);
                current = next;
            }
        }
        return null;
    }

    async _observeDom(gen) {
        if (gen !== this._generation) return [];
        const observation = await this._sendToContent('ANALYZE_DOM', {});
        if (gen !== this._generation) return [];
        return Array.isArray(observation?.elements) ? observation.elements : [];
    }

    /**
     * Wait for a content script to answer again, in place, without spending a
     * cycle on each attempt.
     *
     * A refused message means the document underneath the agent was replaced,
     * not that the page is broken, so the run has to pick up the same goal on
     * the new document.  Waiting here keeps the cycle budget for real work
     * instead of consuming one cycle per poll.
     */
    async _awaitContentScript(gen) {
        const probe = async delay => {
            if (gen !== this._generation || !this.running) return false;
            await this._sendToContent('ANALYZE_DOM', {});
            if (gen !== this._generation || !this.running) return false;
            // Attached is enough: a document that is still parsing answers with
            // no controls, and the next cycle re-observes it as it fills in.
            if (this._lastMessageDelivered) return true;
            await this._sleep(delay);
            return false;
        };
        for (let attempt = 0; attempt < MAX_PAGE_LOAD_POLLS; attempt++) {
            if (await probe(PAGE_LOAD_DELAYS_MS[attempt])) return true;
            if (gen !== this._generation || !this.running) return false;
        }
        // The bound above is for a page that stopped answering.  A tab that is
        // still loading is mid-navigation, so it gets a longer grace.
        for (let waited = 0; waited < MAX_PAGE_LOAD_LINGER_MS; waited += 1000) {
            if (!await this._isTabLoading()) return false;
            if (await probe(1000)) return true;
            if (gen !== this._generation || !this.running) return false;
        }
        return false;
    }

    /** Whether the browser still reports this tab as loading, when it can. */
    _isTabLoading() {
        return new Promise(resolve => {
            try {
                if (!globalThis.chrome?.tabs?.get) return resolve(false);
                chrome.tabs.get(this.tabId, tab => {
                    if (chrome.runtime.lastError) return resolve(false);
                    resolve(String(tab?.status || '') === 'loading');
                });
            } catch (_) {
                resolve(false);
            }
        });
    }

    /**
     * Handle a refused content-script message: treat it as a navigation when
     * the page comes back, and only give up when it never does.
     *
     * Returns 'recovered' when this loop took over the resume, 'superseded'
     * when the page-load event already bumped the generation and resumed the
     * run underneath us, and 'unavailable' only when the bounded wait expired
     * with the same generation, which means the tab really is unreachable.
     * Recovery reuses continueAfterNavigation so the run resets exactly the
     * same way whether the page-load event or the loop notices the swap first.
     */
    async _recoverFromPageSwap(gen) {
        this._broadcastRoute('local', 'running', 'The page is reloading after navigation');
        this._broadcast({
            type: 'AGENT_UPDATE',
            log: 'The page navigated; waiting for it to finish loading before continuing.',
            logLevel: 'warn',
            cycle: this.cycleCount
        });
        if (!await this._awaitContentScript(gen)) {
            // A concurrent page-load event bumps the generation to resume the
            // run.  That resume is the recovery, so this cycle must stand down
            // instead of declaring the tab unreachable over its shoulder.
            return gen === this._generation ? 'unavailable' : 'superseded';
        }
        this.continueAfterNavigation();
        return 'recovered';
    }

    _clearScheduledCycle() {
        if (this._scheduledTimer != null) {
            try { clearTimeout(this._scheduledTimer); } catch (_) { /* noop */ }
            this._scheduledTimer = null;
        }
    }

    _scheduleNextCycle(gen, delay = ACTION_SETTLE_MS) {
        if (!this.running || gen !== this._generation) return;
        this._clearScheduledCycle();
        this._scheduledTimer = setTimeout(() => {
            this._scheduledTimer = null;
            if (this.running && gen === this._generation) return this._cycle(gen);
            return undefined;
        }, delay);
    }

    _expectedText(actions) {
        const fromAction = (Array.isArray(actions) ? actions : []).find(action =>
            action?.type === 'type_local' && typeof action.args?.text === 'string'
        );
        if (fromAction) return fromAction.args.text;
        return this._extractGoalText(this.goal);
    }

    _extractGoalText(goal) {
        const value = String(goal || '');
        const quoted = value.match(/["']([^"']{1,200})["']/);
        if (quoted) return quoted[1].trim();
        const named = value.match(/\b(?:named|called|titled)\s+(?:the\s+)?(.+?)(?=\s+(?:and|then|by|using|with)\s+|$)/i);
        return named ? named[1].trim() : '';
    }

    _isTaskMutationGoal() {
        const goal = String(this.goal || '').toLowerCase();
        const hasTaskNoun = /\b(?:task|todo|note|memo)\b/.test(goal);
        const hasCreateVerb = /\b(?:add|create|new)\b/.test(goal);
        const hasImplicitQuotedTask = /\b(?:task|todo|note|memo)\s*(?:(?:named|called|titled)\s+)?["'][^"']{1,200}["']/.test(goal);
        return (hasTaskNoun && hasCreateVerb) || hasImplicitQuotedTask;
    }

    _isMessageMutationGoal() {
        const goal = String(this.goal || '').toLowerCase();
        return /\b(?:send|write|type)\b.*\b(?:message|chat|conversation|text\s*box|textbox)\b|\b(?:message|chat|text\s*box|textbox)\b.*\b(?:send|write|type)\b/i.test(goal);
    }

    async _verifyCompletion(domElements, pending, gen) {
        const expected = String(pending.expectedText || '').trim();
        if (expected && (pending.mutation || this._isTaskMutationGoal())) {
            for (let attempt = 0; attempt <= TARGET_POLL_DELAYS_MS.length; attempt++) {
                if (this._domContainsCompletedText(domElements, expected)) {
                    return { complete: true };
                }
                if (attempt >= TARGET_POLL_DELAYS_MS.length) break;
                await this._sleep(TARGET_POLL_DELAYS_MS[attempt]);
                if (gen !== this._generation) break;
                const next = await this._observeDom(gen);
                domElements = next;
            }
            return { complete: false, reason: 'expected text was not observed' };
        }
        return { complete: pending.meaningfulActionsExecuted > 0 };
    }

    _domContainsCompletedText(domElements, expected) {
        const wanted = String(expected || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!wanted) return false;
        return (Array.isArray(domElements) ? domElements : []).some(node => {
            if (!node || node.visible === false) return false;
            const tag = String(node.tag || '').toLowerCase();
            const inputType = String(node.inputType || '').toLowerCase();
            const editable = ['input', 'textarea'].includes(tag) || inputType === 'contenteditable' ||
                ['textbox', 'searchbox', 'combobox'].includes(String(node.role || '').toLowerCase());
            if (editable) return false;
            const values = [node.text, node.ariaLabel, node.label, node.placeholder, node.name]
                .filter(Boolean)
                .map(value => String(value).replace(/\s+/g, ' ').trim().toLowerCase());
            return values.some(value => value.includes(wanted));
        });
    }

    /**
     * True when an editable task field already holds the requested text.
     *
     * This separates submitting a staged task from creating an unnamed
     * duplicate: both look identical to a "did we already click this?" check,
     * but only the former has text waiting to be committed.
     */
    _taskFieldHoldsText(domElements, expected) {
        const wanted = String(expected || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!wanted) return false;
        return (Array.isArray(domElements) ? domElements : []).some(node => {
            if (!node || node.visible === false) return false;
            const tag = String(node.tag || '').toLowerCase();
            const inputType = String(node.inputType || '').toLowerCase();
            const role = String(node.role || '').toLowerCase();
            const editable = ['input', 'textarea'].includes(tag) ||
                inputType === 'contenteditable' ||
                ['textbox', 'searchbox', 'combobox'].includes(role);
            if (!editable) return false;
            // An identity or search control never stages ordinary task text.
            if (this._isIdentityNode(node)) return false;
            const values = [node.text, node.ariaLabel]
                .filter(Boolean)
                .map(value => String(value).replace(/\s+/g, ' ').trim().toLowerCase());
            return values.some(value => value.includes(wanted));
        });
    }

    _shouldBlockRepeatedCreate(actions, domElements) {
        if (!this._isCreateOnlyPlan(actions, domElements)) return false;
        if (!this._hasExecutedCreateAction(actions, domElements)) return false;
        // Clicking the create control while the requested text is already
        // staged in a task field submits that task.  The guard exists to stop
        // repeated clicks creating unnamed duplicates, so it must not fire here
        // or the run dies with the task typed but never committed.
        const expected = this._extractGoalText(this.goal);
        if (expected && this._taskFieldHoldsText(domElements, expected)) return false;
        return true;
    }

    _stopDuplicateCreate() {
        this.running = false;
        logger.warn('Repeated create-only plan; stopping to prevent unnamed items');
        this._broadcast({
            type: 'AGENT_UPDATE',
            status: 'error',
            error: 'The create control was clicked, but no task field became available.',
            log: 'Stopped after one create attempt because no task field was available; preventing unnamed duplicates.',
            logLevel: 'warn',
            cycle: this.cycleCount
        });
    }

    _recordActionAttempt(action, observationKey) {
        const key = this._actionKey(action);
        const previous = this._recentActionAttempts.get(key);
        this._recentActionAttempts.set(key, {
            count: (previous?.count || 0) + 1,
            observationKey
        });
    }

    _debugTarget(target) {
        const value = String(target || '');
        if (!value || /^pva-[a-z0-9-]+$/i.test(value)) return value;
        let hash = 2166136261;
        for (let index = 0; index < value.length; index++) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `target-${(hash >>> 0).toString(36)}`;
    }

    _safeActionsForBroadcast(actions) {
        return (Array.isArray(actions) ? actions : []).map(action => {
            const args = { ...(action.args || {}) };
            if (Object.prototype.hasOwnProperty.call(args, 'text')) args.text = '[LOCAL_TEXT]';
            if (Object.prototype.hasOwnProperty.call(args, 'value')) args.value = '[LOCAL_VALUE]';
            return { type: action.type, target: action.target || '', args };
        });
    }

    _isUnsafePasswordTextAction(action, domElements) {
        if (action.type !== 'type_local' || action.args?.secret_ref) return false;
        if (typeof action.args?.text !== 'string' && typeof action.args?.value !== 'string') return false;

        const target = String(action.target || '').replace(/^#/, '');
        const node = (Array.isArray(domElements) ? domElements : [])
            .find(item => String(item?.id || '').replace(/^#/, '') === target);
        if (!node) return false;

        const inputType = String(node.inputType || '').toLowerCase();
        const autocomplete = String(node.autocomplete || '').toLowerCase();
        const identity = [node.id, node.name, node.ariaLabel, node.placeholder, node.label, node.title, node.testId]
            .filter(Boolean).join(' ')
            .toLowerCase();
        return inputType === 'password' ||
            autocomplete === 'current-password' ||
            autocomplete === 'new-password' ||
            /password|passwd|pwd/i.test(identity);
    }

    _isIdentityNode(node) {
        if (!node) return false;
        const inputType = String(node.inputType || '').toLowerCase();
        const autocomplete = String(node.autocomplete || '').toLowerCase();
        const identity = [node.id, node.name, node.ariaLabel, node.placeholder, node.label, node.title, node.testId]
            .filter(Boolean).join(' ')
            .toLowerCase();
        if (['email', 'password', 'tel', 'url'].includes(inputType)) return true;
        if (['email', 'username', 'tel', 'search', 'current-password', 'new-password'].includes(autocomplete)) return true;
        if (String(node.role || '').toLowerCase() === 'searchbox') return true;
        if (/\b(?:e[-\s]?mail|username|user\s*name|user\s*id|account|login|log\s*in|sign\s*in|credential|phone|telephone)\b/.test(identity)) return true;
        // A search/filter control is not a task composer.  Server plans that
        // type ordinary task text into one are blocked here for the same
        // reason the deterministic local planner refuses such a target.
        if (/\b(?:search|filter|find)\b/.test(identity)) return true;
        return false;
    }

    /**
     * A third-party identity provider control: "Continue with Google",
     * "Sign in with Apple", "Log in via SAML".
     *
     * A local credential path ("... with email") is deliberately not matched,
     * so this never blocks signing in with the credentials the agent holds.
     */
    _isFederatedProviderNode(node) {
        if (!node) return false;
        const label = [node.id, node.name, node.ariaLabel, node.placeholder, node.label, node.title, node.testId, node.text]
            .filter(Boolean).join(' ');
        return /\b(?:continue|log\s*in|login|sign\s*in|sign\s*up|register)\s+(?:with|via|using)\s+(?!email\b|e-mail\b|password\b|username\b|user\s*name\b|phone\b|your\b)\w/i
            .test(label);
    }

    /** True when the page presents its own email/password form. */
    _hasLocalCredentialField(domElements) {
        return (Array.isArray(domElements) ? domElements : []).some(node => {
            if (!node) return false;
            const inputType = String(node.inputType || '').toLowerCase();
            const autocomplete = String(node.autocomplete || '').toLowerCase();
            if (['password', 'email', 'tel'].includes(inputType)) return true;
            return ['email', 'current-password', 'new-password', 'username'].includes(autocomplete);
        });
    }

    /**
     * Clicking a federated provider would hand authentication to a third
     * party and cannot complete using the locally held credentials, so such a
     * click is refused while the page also offers its own credential form.
     */
    _isUnsafeFederatedClick(action, domElements) {
        if (action?.type !== 'click') return false;
        if (!this._hasLocalCredentialField(domElements)) return false;
        const target = String(action.target || '').replace(/^#/, '');
        const node = (Array.isArray(domElements) ? domElements : [])
            .find(item => String(item?.id || '').replace(/^#/, '') === target);
        return this._isFederatedProviderNode(node);
    }

    _isUnsafeIdentityTextAction(action, domElements) {
        if (action.type !== 'type_local' || action.args?.secret_ref) return false;
        if (typeof action.args?.text !== 'string' && typeof action.args?.value !== 'string') return false;
        const target = String(action.target || '').replace(/^#/, '');
        const node = (Array.isArray(domElements) ? domElements : [])
            .find(item => String(item?.id || '').replace(/^#/, '') === target);
        // A search field is normally refused because typing into one is how a
        // plan tries to dodge the task it was actually given.  When searching
        // is the requested action, that reasoning does not apply, so the
        // query is allowed through — but only the query, and only into a field
        // that really is a search control.
        if (this._isPermittedSearchText(action, node)) return false;
        return this._isIdentityNode(node);
    }

    /**
     * True when this text action is the search the goal actually asked for.
     *
     * Requires a search-shaped goal, a genuine search control as the target,
     * and text equal to the requested query.  Anything looser would reopen the
     * hole this rule exists to close: arbitrary text typed into a search box
     * instead of doing the work.
     */
    _isPermittedSearchText(action, node) {
        if (!node) return false;
        const query = this._searchQuery(this.goal);
        const text = String(action.args?.text ?? action.args?.value ?? '').replace(/\s+/g, ' ').trim();
        // Only the exact query the goal asked for.  A goal that names no query
        // cannot pass this, because no text equals an empty one.
        if (!text || text.toLowerCase() !== query.toLowerCase()) return false;
        if (String(node.role || '').toLowerCase() === 'searchbox') return true;
        const inputType = String(node.inputType || '').toLowerCase();
        if (inputType === 'search') return true;
        const identity = [node.name, node.ariaLabel, node.placeholder, node.label, node.title, node.id]
            .filter(Boolean).join(' ').toLowerCase();
        return /\b(?:search|query|keyword)\b/.test(identity);
    }

    /**
     * The query text a search goal is asking for, or '' when not a search.
     *
     * This reads the planner's intent rather than parsing the goal again.  Two
     * independent parsers drift apart, and when they do the gate below starts
     * rejecting the very query the planner legitimately typed, which looks
     * exactly like the search not working.
     */
    _searchQuery(goal) {
        return this.localAgent?._searchIntent?.(goal)?.query || '';
    }

    _planHasUnsafeIdentityText(actions, domElements) {
        return (Array.isArray(actions) ? actions : []).some(action =>
            this._isUnsafePasswordTextAction(action, domElements) ||
            this._isUnsafeIdentityTextAction(action, domElements)
        );
    }

    _isKnownTarget(action, domElements) {
        if (action.type === 'wait' || action.type === 'done') return true;
        if (action.type === 'keypress' && !String(action.target || '').trim()) return true;
        if (action.type === 'scroll') {
            const scrollTarget = String(action.target || '').replace(/^#/, '').toLowerCase();
            return !scrollTarget || ['body', 'html', 'window', 'document'].includes(scrollTarget);
        }
        return resolveActionTarget(action, domElements).status === 'resolved';
    }

    _isProviderErrorAction(action) {
        if (action.type !== 'wait') return false;
        const reason = String(action.args?.reason || '');
        return /vlm error|timeout|quota|rate limit|provider/i.test(reason);
    }

    async _executeAction(action, gen) {
        const result = await this._sendToContent('EXECUTE_VALIDATED_ACTION', { action });
        if (gen !== this._generation) return result;
        // Stale targets are handled by the caller's fresh observation and plan
        // transition.  Never replay a click here: the page may have accepted
        // the first event even if the response was lost.
        return result;
    }

    _recordMessageActionProgress(action, domElements, pending) {
        if (!this._isMessageMutationGoal()) return;

        if (action?.type === 'type_local' && !action.args?.secret_ref &&
            typeof action.args?.text === 'string' && action.args.text.trim()) {
            if (this._messageState?.phase !== 'submitted') {
                this._messageState = {
                    phase: 'draft',
                    text: action.args.text,
                    draftPolls: 0
                };
            }
            return;
        }

        if (this._isMessageSubmissionAction(action, domElements)) {
            const text = this._messageState?.text || this._extractGoalText(this.goal);
            if (text) {
                this._messageState = {
                    phase: 'submitted',
                    text,
                    method: action.type === 'keypress' ? 'Enter' : 'send control',
                    polls: 0
                };
                this._notifyMessage('submitted', { text, method: this._messageState.method });
            }
        }
    }

    _notifyMessage(event, payload) {
        const callback = event === 'submitted'
            ? this._onMessageSubmitted
            : event === 'confirmed'
                ? this._onMessageConfirmed
                : this._onMessageUnconfirmed;
        try { callback(payload); } catch (_) { /* guard must not break execution */ }
    }

    _isMessageSubmissionAction(action, domElements) {
        if (!this._isMessageMutationGoal()) return false;
        if (action?.type === 'keypress') {
            if (action.args?.key !== 'Enter') return false;
            if (!String(action.target || '').trim()) return true;
            const node = this._domNodeForAction(action, domElements);
            const tag = String(node?.tag || '').toLowerCase();
            const type = String(node?.inputType || '').toLowerCase();
            const role = String(node?.role || '').toLowerCase();
            return !!node && (tag === 'input' || tag === 'textarea' || type === 'contenteditable' ||
                ['textbox', 'searchbox', 'combobox'].includes(role));
        }
        if (action?.type !== 'click') return false;

        const node = this._domNodeForAction(action, domElements);
        if (!node) return false;
        const tag = String(node.tag || '').toLowerCase();
        const role = String(node.role || '').toLowerCase();
        const buttonLike = tag === 'button' || tag === 'a' ||
            ['button', 'link', 'menuitem'].includes(role);
        if (!buttonLike) return false;
        const identity = [node.id, node.name, node.ariaLabel, node.label, node.text, node.placeholder]
            .filter(Boolean).join(' ').toLowerCase();
        return /\b(?:send|submit|message|chat)\b/.test(identity);
    }

    _observedMessageEditor(domElements) {
        const candidates = (Array.isArray(domElements) ? domElements : [])
            .filter(node => {
                if (!node || node.visible === false || node.enabled === false) return false;
                const tag = String(node.tag || '').toLowerCase();
                const role = String(node.role || '').toLowerCase();
                const type = String(node.inputType || '').toLowerCase();
                const editable = tag === 'input' || tag === 'textarea' || type === 'contenteditable' ||
                    ['textbox', 'searchbox', 'combobox'].includes(role);
                if (!editable) return false;
                const identity = [node.ariaLabel, node.label, node.placeholder, node.name, node.id]
                    .filter(Boolean).join(' ').toLowerCase();
                return !/\b(?:search|filter|find)\b/.test(identity);
            })
            .map(node => {
                const identity = [node.ariaLabel, node.label, node.placeholder, node.name, node.id]
                    .filter(Boolean).join(' ').toLowerCase();
                let score = 0;
                if (/\b(?:message|chat|conversation|reply|write)\b/.test(identity)) score += 6;
                if (String(node.inputType || '').toLowerCase() === 'contenteditable') score += 4;
                if (['textbox', 'combobox'].includes(String(node.role || '').toLowerCase())) score += 2;
                return { node, score };
            })
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
        if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score)) return null;
        return candidates[0].node;
    }

    _messageComposerCleared(domElements) {
        const editor = this._observedMessageEditor(domElements);
        if (!editor) return false;
        const draft = String(editor.text || '')
            .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (draft) return false;

        const sendStillVisible = (Array.isArray(domElements) ? domElements : []).some(node => {
            if (!node || node.visible === false || node.enabled === false) return false;
            const tag = String(node.tag || '').toLowerCase();
            const role = String(node.role || '').toLowerCase();
            if (tag !== 'button' && tag !== 'a' && !['button', 'link', 'menuitem'].includes(role)) return false;
            const identity = [node.id, node.name, node.ariaLabel, node.label, node.text, node.placeholder]
                .filter(Boolean).join(' ').toLowerCase();
            return /\bsend\b/.test(identity);
        });
        return !sendStillVisible;
    }

    _handleMessageSubmissionState(domElements, gen) {
        const state = this._messageState;
        if (!state || state.phase !== 'submitted') return false;

        const bubbleVisible = Boolean(
            state.text && this._domContainsCompletedText(domElements, state.text)
        );
        const composerCleared = state.polls > 0 && this._messageComposerCleared(domElements);
        if (bubbleVisible || composerCleared) {
            this._notifyMessage('confirmed', {
                text: state.text,
                method: state.method || 'send action'
            });
            this._messageState = null;
            this.running = false;
            this._broadcast({
                type: 'AGENT_UPDATE',
                source: 'local',
                status: 'done',
                log: bubbleVisible
                    ? 'Message submission verified in the current conversation.'
                    : 'Send action completed and the message composer cleared; the outgoing bubble is virtualized.',
                cycle: this.cycleCount
            });
            return true;
        }

        state.polls = (state.polls || 0) + 1;
        if (state.polls > MAX_MESSAGE_CONFIRMATION_POLLS) {
            this._notifyMessage('unconfirmed', {
                text: state.text,
                method: state.method || 'send action'
            });
            this._messageState = null;
            this._fail(
                `Message ${state.method || 'send action'} was attempted, but the sent message was not observed; not retrying to avoid a duplicate.`,
                gen
            );
            return true;
        }

        const delay = MESSAGE_CONFIRMATION_DELAYS_MS[
            Math.min(state.polls - 1, MESSAGE_CONFIRMATION_DELAYS_MS.length - 1)
        ];
        this._scheduleNextCycle(gen, delay);
        return true;
    }

    _holdTaskDiscovery(gen) {
        this._taskDiscoveryPolls = (this._taskDiscoveryPolls || 0) + 1;
        if (this._taskDiscoveryPolls > MAX_TASK_DISCOVERY_POLLS) {
            this._taskDiscoveryPolls = 0;
            this._broadcast({
                type: 'AGENT_UPDATE',
                source: 'local',
                log: 'Task composer was not observed after the bounded local wait; continuing with local vision.',
                logLevel: 'warn',
                cycle: this.cycleCount
            });
            return false;
        }
        this._broadcastRoute('local', 'running', 'Waiting for the task composer to mount locally');
        const delay = TASK_DISCOVERY_DELAYS_MS[
            Math.min(this._taskDiscoveryPolls - 1, TASK_DISCOVERY_DELAYS_MS.length - 1)
        ];
        this._scheduleNextCycle(gen, delay);
        return true;
    }

    _holdMessageDraft(gen) {
        const state = this._messageState;
        if (!state || state.phase !== 'draft') return;
        state.draftPolls = (state.draftPolls || 0) + 1;
        if (state.draftPolls > MAX_MESSAGE_DRAFT_POLLS) {
            this._messageState = null;
            this._fail(
                'The message was typed, but a safe send control could not be grounded; not typing it again.',
                gen
            );
            return;
        }
        this._scheduleNextCycle(gen, MESSAGE_CONFIRMATION_DELAYS_MS[
            Math.min(state.draftPolls - 1, MESSAGE_CONFIRMATION_DELAYS_MS.length - 1)
        ]);
    }

    _isDuplicate(action, observationKey = '') {
        const key = this._actionKey(action);
        const recent = this._recentActionAttempts.get(key);
        if (recent && (recent.observationKey === observationKey || recent.count >= MAX_ACTION_ATTEMPTS)) return true;
        return this.lastActions.some(entry =>
            entry.revision === this._actionRevision &&
            this._actionKey(entry.action) === key
        );
    }

    _actionKey(action) {
        let args = {};
        try {
            args = { ...(action.args || {}) };
            // Do not retain ordinary user text in duplicate/debug keys.
            if (Object.prototype.hasOwnProperty.call(args, 'text')) args.text = '[LOCAL_TEXT]';
            if (Object.prototype.hasOwnProperty.call(args, 'value')) args.value = '[LOCAL_VALUE]';
        } catch (_) {
            args = { value: '[LOCAL_ARGS]' };
        }
        let serialized = '';
        try { serialized = JSON.stringify(args); } catch (_) { serialized = String(args); }
        return `${action.type}|${action.target || ''}|${serialized}`;
    }

    _planKey(actions) {
        return (Array.isArray(actions) ? actions : [])
            .map(action => this._actionKey(action))
            .join('||');
    }

    _observationKey(context) {
        try {
            const page = context?.page || {};
            const dom = Array.isArray(context?.dom) ? context.dom : [];
            return JSON.stringify({
                url: page.url || context?.url || '',
                route: context?.route || '',
                title: page.title || '',
                dom: dom.map(node => [
                    node?.id || '',
                    node?.tag || '',
                    node?.text || '',
                    node?.inputType || '',
                    node?.bbox || null
                ])
            });
        } catch (_) {
            return '';
        }
    }

    _domNodeForAction(action, domElements) {
        const target = String(action?.target || '').replace(/^#/, '');
        return (Array.isArray(domElements) ? domElements : [])
            .find(node => String(node?.id || '').replace(/^#/, '') === target) || null;
    }

    _createActionKey(action, domElements) {
        const node = this._domNodeForAction(action, domElements);
        const identity = node
            ? [node.tag, node.role, node.text, node.placeholder, node.ariaLabel, node.label]
                .map(value => String(value || '').toLowerCase().trim())
                .join('|')
            : String(action?.target || '').toLowerCase();
        return `${action?.type || ''}|${identity}`;
    }

    _isCreateAction(action, domElements) {
        if (action?.type !== 'click') return false;
        const node = this._domNodeForAction(action, domElements);
        const identity = node
            ? [
                node.id,
                node.tag,
                node.role,
                node.text,
                node.placeholder,
                node.ariaLabel,
                node.name,
                node.label,
                action?.target
            ]
                .map(value => String(value || '').toLowerCase())
                .join(' ')
            : String(action?.target || '').toLowerCase();
        if (/\b(save|submit|confirm|login|sign\s*in)\b/.test(identity)) return false;
        return /\b(add|new|create)\b/.test(identity);
    }

    _isCreateOnlyPlan(actions, domElements) {
        const executable = (Array.isArray(actions) ? actions : [])
            .filter(action => action?.type !== 'done' && action?.type !== 'wait');
        return executable.length > 0 && executable.every(action =>
            this._isCreateAction(action, domElements)
        );
    }

    _hasExecutedCreateAction(actions, domElements) {
        return (Array.isArray(actions) ? actions : []).some(action =>
            this._isCreateAction(action, domElements) &&
            this._executedCreateKeys.has(this._createActionKey(action, domElements))
        );
    }

    _fail(message, gen) {
        if (gen !== this._generation) return;
        logger.warn(message);
        this.running = false;
        this._broadcast({
            type: 'AGENT_UPDATE',
            status: 'error',
            error: message,
            cycle: this.cycleCount
        });
    }

    async _backoff(gen) {
        const delay = BACKOFF_BASE_MS * Math.min(this.cycleCount, 8);
        await this._sleep(delay);
        if (this.running && gen === this._generation) await this._cycle(gen);
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _newId() {
        try {
            return crypto.randomUUID();
        } catch (_) {
            return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }
    }

    // Send a message to the content script and handle chrome.runtime.lastError.
    /**
     * Send a message to the content script.
     *
     * "No receiving end" and "received, but it had nothing to say" are very
     * different: the first means the document underneath the agent is being
     * replaced, so the run should wait for the new one, while the second is a
     * page that genuinely exposes no matching controls.  Collapsing the two is
     * what turned an ordinary navigation into a fatal error, so delivery is
     * recorded separately from the response for callers that care.
     */
    _sendToContent(type, payload) {
        return new Promise((resolve) => {
            try {
                chrome.tabs.sendMessage(this.tabId, { type, ...payload }, (response) => {
                    if (chrome.runtime.lastError) {
                        logger.warn('Content script message error: ' + chrome.runtime.lastError.message);
                        this._lastMessageDelivered = false;
                        resolve(null);
                    } else {
                        this._lastMessageDelivered = true;
                        resolve(response ?? null);
                    }
                });
            } catch (e) {
                logger.error('sendMessage threw: ' + e.message);
                this._lastMessageDelivered = false;
                resolve(null);
            }
        });
    }

    _broadcastRoute(route, modelStatus = 'running', detail = '') {
        const model = route === 'server' ? 'server-provider' :
            route === 'local-vision' ? 'local-vlm' :
                route === 'privacy' ? 'local-privacy' : 'local-rules';
        this._broadcast({
            type: 'AGENT_UPDATE',
            route,
            model,
            modelStatus,
            routeDetail: detail
        });
    }

    // Safely broadcast to popup; it may be closed.
    _broadcast(msg) {
        try {
            chrome.runtime.sendMessage(msg, () => {
                void chrome.runtime.lastError;
            });
        } catch (_) {
            // Popup closed.
        }
    }
}
