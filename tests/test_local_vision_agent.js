import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LocalVisionAgent } from '../extension/background/local_vision_agent.js';
import { LocalVisionRuntime } from '../extension/background/local_vision_runtime.js';
import { validateActionPlan } from '../extension/background/api_client.js';
import { buildLocalVisionPrompt, parseLocalVisionOutput, prepareLocalDomMetadata } from '../extension/local_agent/local_vision_protocol.js';
import { detectLocalVlmBackend } from '../extension/local_agent/local_vlm_runtime.js';
import { AgentLoop } from '../extension/background/agent_loop.js';
import { PrivacyPipelineRunner } from '../extension/content/privacy_pipeline_runner.js';

function node(id, values = {}) {
    return {
        id,
        tag: 'button',
        role: '',
        text: '',
        inputType: '',
        autocomplete: '',
        placeholder: '',
        ariaLabel: '',
        name: '',
        label: '',
        options: [],
        bbox: { x: 0, y: 0, width: 120, height: 32 },
        visible: true,
        enabled: true,
        ...values
    };
}

function elements() {
    return [
        node('submit', { text: 'Submit' }),
        node('email', { tag: 'input', inputType: 'email', placeholder: 'Email' }),
        node('password', { tag: 'input', inputType: 'password', placeholder: 'Password' })
    ];
}

function observation(dom = elements()) {
    return {
        dom,
        image: 'data:image/png;base64,RAW-LOCAL-SCREENSHOT',
        ocr: [{ text: 'Submit', bbox: { x: 10, y: 10, width: 40, height: 20 } }]
    };
}

class RecordingRuntime {
    constructor(result) {
        this.result = result;
        this.calls = [];
    }

    async infer(input) {
        this.calls.push(input);
        return typeof this.result === 'function' ? this.result(input) : this.result;
    }
}

function serverContext(dom = elements()) {
    return {
        allowed: true,
        sanitizedContext: {
            page: { url: 'https://example.test', title: 'Example', viewport: { width: 100, height: 100 } },
            dom,
            image: 'data:image/jpeg;base64,SANITIZED',
            goal: 'redacted'
        },
        redactionPlan: []
    };
}

async function runLoop(goal, {
    runtimeResult = { ok: true, actions: [{ type: 'click', target: 'submit', args: {} }, { type: 'done', target: '', args: {} }] },
    complex = false
} = {}) {
    const runtime = new RecordingRuntime(runtimeResult);
    const loop = new AgentLoop(12, goal, {
        localVisionAgent: new LocalVisionAgent({ runtime })
    });
    const updates = [];
    const executed = [];
    let privacyCalls = 0;
    let backendCalls = 0;
    let sentToServer = null;
    loop.client.plan = async (context) => {
        backendCalls++;
        sentToServer = context;
        return { success: true, actions: [{ type: 'done', target: '', args: {} }] };
    };
    loop._sendToContent = async (type, payload = {}) => {
        if (type === 'ANALYZE_DOM') return { elements: elements() };
        if (type === 'LOCAL_VISION_OBSERVE') return observation();
        if (type === 'PRIVACY_PIPELINE') {
            privacyCalls++;
            return serverContext();
        }
        if (type === 'EXECUTE_VALIDATED_ACTION') {
            executed.push(payload.action);
            return { success: true };
        }
        return null;
    };
    loop._broadcast = update => updates.push(update);
    loop._sleep = async () => {};
    loop.running = true;
    loop._generation = 0;
    await loop._cycle(0);
    return { loop, runtime, updates, executed, privacyCalls, backendCalls, sentToServer };
}

describe('Local browser vision agent', () => {
    test('accepts a structured visual plan only through the shared validator', async () => {
        const runtime = new RecordingRuntime({
            ok: true,
            actions: [
                { type: 'click', target: 'submit', args: {} },
                { type: 'done', target: '', args: {} }
            ],
            metrics: { backend: 'wasm', coldInitMs: 12, warmInferenceMs: 4, inferenceCount: 1 }
        });
        const agent = new LocalVisionAgent({ runtime });
        const result = await agent.analyze('click the blue submit button', observation());
        assert.strictEqual(result.decision, 'LOCAL');
        assert.strictEqual(validateActionPlan(result.actions).ok, true);
        assert.strictEqual(runtime.calls.length, 1);
        assert.strictEqual(runtime.calls[0].image, observation().image);
        assert.strictEqual(runtime.calls[0].dom.length, 3);
    });

    test('accepts bounded ordinary task text in a grounded editor', async () => {
        const runtime = new RecordingRuntime({
            ok: true,
            actions: [
                { type: 'type_local', target: 'task-editor', args: { text: 'Study Cpp' } },
                { type: 'done', target: '', args: {} }
            ]
        });
        const dom = [...elements(), node('task-editor', {
            tag: 'div',
            role: 'textbox',
            inputType: 'contenteditable',
            ariaLabel: 'Task title'
        })];
        const result = await new LocalVisionAgent({ runtime }).analyze(
            'add a task named "Study Cpp"',
            observation(dom)
        );
        assert.strictEqual(result.decision, 'LOCAL');
        assert.strictEqual(result.actions[0].args.text, 'Study Cpp');
    });

    test('rejects ordinary task text aimed at an identity field', async () => {
        const runtime = new RecordingRuntime({
            ok: true,
            actions: [
                { type: 'type_local', target: 'email', args: { text: 'Study Cpp' } },
                { type: 'done', target: '', args: {} }
            ]
        });
        const result = await new LocalVisionAgent({ runtime }).analyze(
            'add a task named "Study Cpp"',
            observation()
        );
        assert.strictEqual(result.decision, 'SERVER');
    });

    test('passes bounded sanitized DOM metadata and OCR to the model', async () => {
        const runtime = new RecordingRuntime({ ok: false, abstained: true, reason: 'model-abstained' });
        const agent = new LocalVisionAgent({ runtime });
        const dom = [
            ...elements(),
            node('secret', { tag: 'input', inputType: 'password', text: 'correct horse battery staple' }),
            node('private-value', { tag: 'input', inputType: 'text', text: 'private note value' }),
            node('email-value', { text: 'alice@example.com' })
        ];
        await agent.analyze('click the submit button', { ...observation(dom), ocr: [{ text: 'alice@example.com' }] });
        const serialized = JSON.stringify(runtime.calls[0]);
        assert.equal(serialized.includes('correct horse battery staple'), false);
        assert.equal(serialized.includes('private note value'), false);
        assert.equal(serialized.includes('alice@example.com'), false);
        assert.match(runtime.calls[0].dom.find(item => item.id === 'secret').text, /LOCAL_SECRET/);
    });

    test('reuses one injected runtime/session across multiple inferences', async () => {
        const runtime = new RecordingRuntime({ ok: false, abstained: true });
        const agent = new LocalVisionAgent({ runtime });
        await agent.analyze('click the blue submit button', observation());
        await agent.analyze('focus the email field', observation());
        assert.strictEqual(runtime.calls.length, 2);
        assert.strictEqual(runtime, agent.runtime);
    });

    test('grounds a model label to a unique existing element', () => {
        const parsed = parseLocalVisionOutput(
            '{"decision":"LOCAL","actions":[{"type":"click","target":"Submit","args":{}},{"type":"done","target":"","args":{}}]}',
            'click the blue submit button',
            elements()
        );
        assert.strictEqual(parsed.ok, true);
        assert.strictEqual(parsed.actions[0].target, 'submit');
    });

    test('grounds visual find/which-field questions to safe canonical actions', () => {
        const login = parseLocalVisionOutput('Login', 'find the login button', [
            node('login', { text: 'Login' })
        ]);
        assert.strictEqual(login.ok, true);
        assert.strictEqual(login.actions[0].type, 'click');
        const title = parseLocalVisionOutput('Task title', 'Which field contains the task title?', [
            node('task-title', { tag: 'input', placeholder: 'Task title' })
        ]);
        assert.strictEqual(title.ok, true);
        assert.strictEqual(title.actions[0].type, 'focus');
        const enter = parseLocalVisionOutput('Enter', 'press Enter to submit', [
            node('task-title', { tag: 'input', placeholder: 'Task title' })
        ]);
        assert.strictEqual(enter.ok, true);
        assert.strictEqual(enter.actions[0].type, 'keypress');
    });

    test('rejects invented targets and executable model arguments', async () => {
        const runtime = new RecordingRuntime({
            ok: true,
            actions: [{ type: 'click', target: 'not-on-page', args: { code: 'alert(1)' } }, { type: 'done' }]
        });
        const result = await new LocalVisionAgent({ runtime }).analyze('click the blue submit button', observation());
        assert.strictEqual(result.decision, 'SERVER');
        assert.match(result.reason, /grounded|validation/i);
    });

    test('successful local vision executes without privacy pipeline or backend requests', async () => {
        const result = await runLoop('click the blue submit button');
        assert.strictEqual(result.backendCalls, 0);
        assert.strictEqual(result.privacyCalls, 0);
        assert.deepStrictEqual(result.executed.map(action => action.type), ['click']);
        assert.ok(result.updates.some(update => update.source === 'local-vision' && update.status === 'done'));
    });

    test('local vision abstention still uses the privacy gate before the server', async () => {
        const result = await runLoop('click the blue submit button', {
            runtimeResult: { ok: false, abstained: true, reason: 'model-abstained' }
        });
        assert.strictEqual(result.privacyCalls, 1);
        assert.strictEqual(result.backendCalls, 1);
        assert.equal(result.sentToServer.image.includes('RAW-LOCAL-SCREENSHOT'), false);
    });

    test('complex goals bypass the small local model and remain server tasks', async () => {
        const result = await runLoop('compare products and choose the best one', { complex: true });
        assert.strictEqual(result.runtime.calls.length, 0);
        assert.strictEqual(result.privacyCalls, 1);
        assert.strictEqual(result.backendCalls, 1);
    });

    test('privacy gate failure prevents server escalation after local vision', async () => {
        const loop = new AgentLoop(13, 'click the blue submit button', {
            localVisionAgent: new LocalVisionAgent({
                runtime: new RecordingRuntime({ ok: false, abstained: true })
            })
        });
        let backendCalls = 0;
        let executed = 0;
        loop.client.plan = async () => { backendCalls++; return { success: true, actions: [] }; };
        loop._sendToContent = async (type, payload = {}) => {
            if (type === 'ANALYZE_DOM') return { elements: elements() };
            if (type === 'LOCAL_VISION_OBSERVE') return observation();
            if (type === 'PRIVACY_PIPELINE') return { allowed: false, violations: ['synthetic gate block'] };
            if (type === 'EXECUTE_VALIDATED_ACTION') { executed++; return { success: true }; }
            return null;
        };
        loop._broadcast = () => {};
        loop._sleep = async () => {};
        loop.running = true;
        loop._generation = 0;
        await loop._cycle(0);
        assert.strictEqual(backendCalls, 0);
        assert.strictEqual(executed, 0);
    });

    test('model initialization failure reports LOCAL_VISION_UNAVAILABLE and abstains safely', async () => {
        const result = await runLoop('click the blue submit button', {
            runtimeResult: { ok: false, unavailable: true, reason: 'LOCAL_VISION_UNAVAILABLE' }
        });
        assert.strictEqual(result.backendCalls, 1);
        assert.ok(result.updates.some(update => String(update.log).includes('LOCAL_VISION_UNAVAILABLE')));
    });

    test('WebGPU-unavailable metrics are represented as a WASM fallback without unsafe execution', async () => {
        const result = await runLoop('click the blue submit button', {
            runtimeResult: {
                ok: false,
                unavailable: true,
                reason: 'LOCAL_VISION_UNAVAILABLE',
                metrics: { backend: 'wasm', status: 'ready' }
            }
        });
        assert.strictEqual(result.backendCalls, 1);
        assert.ok(result.updates.some(update => update.localVision?.backend === 'wasm'));
    });

    test('done terminates the local vision task and repeated wait is rejected', async () => {
        const done = await runLoop('click the blue submit button');
        assert.strictEqual(done.loop.cycleCount, 1);
        assert.strictEqual(done.loop.running, false);

        const repeated = await runLoop('click the blue submit button', {
            runtimeResult: {
                ok: true,
                actions: [
                    { type: 'wait', target: '', args: { ms: 10 } },
                    { type: 'wait', target: '', args: { ms: 10 } },
                    { type: 'done', target: '', args: {} }
                ]
            }
        });
        assert.strictEqual(repeated.executed.length, 0);
        assert.strictEqual(repeated.backendCalls, 1);
    });

    test('model input and broadcasts never contain raw PII', async () => {
        const pii = 'private.person@example.com';
        const dom = [...elements(), node('private', { text: pii })];
        const runtime = new RecordingRuntime({ ok: false, abstained: true });
        const result = await new LocalVisionAgent({ runtime }).analyze(
            'click the blue submit button',
            { ...observation(dom), image: `data:image/png;base64,${pii}` }
        );
        assert.strictEqual(result.decision, 'SERVER');
        const metadata = JSON.stringify(runtime.calls[0].dom) + JSON.stringify(runtime.calls[0].ocr);
        assert.equal(metadata.includes(pii), false);
        assert.equal(JSON.stringify(result).includes(pii), false);
    });

    test('protocol prompt names only bounded local metadata and never includes values', () => {
        const prompt = buildLocalVisionPrompt({
            goal: 'click the button',
            domElements: [node('pw', { tag: 'input', inputType: 'password', text: 'do-not-send' })],
            ocrResults: [{ text: 'alice@example.com' }]
        });
        assert.equal(prompt.includes('do-not-send'), false);
        assert.equal(prompt.includes('alice@example.com'), false);
    });

    test('content observation hands a local screenshot and bounded metadata to the vision tier', async () => {
        const dom = elements();
        const runner = new PrivacyPipelineRunner({
            analyzer: { analyzeDOM: () => dom },
            faceDetector: {},
            ocrTrigger: { evaluate: () => ({ shouldRunOCR: false }) },
            ocrProvider: {}
        });
        runner._captureScreenshot = async () => 'data:image/png;base64,LOCAL';
        runner._preprocessImage = async () => ({
            width: 320,
            height: 200,
            toDataURL: () => 'data:image/jpeg;base64,LOCAL'
        });
        const result = await runner.observeForLocalVision();
        assert.strictEqual(result.image, 'data:image/jpeg;base64,LOCAL');
        assert.strictEqual(result.dom.length, 3);
        assert.equal(JSON.stringify(result.dom).includes('value'), false);
    });

    test('WebGPU capability detection falls back without an f16 adapter', async () => {
        assert.deepStrictEqual(await detectLocalVlmBackend({ gpu: { requestAdapter: async () => ({ features: { has: () => false } }) } }), {
            backend: 'wasm',
            reason: 'webgpu-f16-unavailable'
        });
        assert.deepStrictEqual(await detectLocalVlmBackend({}), {
            backend: 'wasm',
            reason: 'webgpu-unavailable'
        });
    });

    test('offscreen client reuses one document and sends local inference messages', async () => {
        const originalChrome = globalThis.chrome;
        let creates = 0;
        let messages = 0;
        globalThis.chrome = {
            runtime: {
                lastError: null,
                getURL: path => `chrome-extension://test/${path}`,
                getContexts: async () => [],
                sendMessage: (_message, callback) => {
                    messages++;
                    callback({ ok: true, actions: [{ type: 'done' }] });
                }
            },
            offscreen: {
                createDocument: (_options, callback) => {
                    creates++;
                    callback();
                }
            }
        };
        try {
            const runtime = new LocalVisionRuntime({ timeoutMs: 5000 });
            await runtime.infer({ goal: 'click', dom: [], image: 'data:image/png;base64,AA==' });
            await runtime.infer({ goal: 'click', dom: [], image: 'data:image/png;base64,AA==' });
            assert.strictEqual(creates, 1);
            assert.strictEqual(messages, 2);
        } finally {
            globalThis.chrome = originalChrome;
        }
    });
});
