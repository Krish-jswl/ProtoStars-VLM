# Development Guide

See [WORKFLOW.md](./WORKFLOW.md) for the complete privacy boundary, request and
response contract, action lifecycle, and troubleshooting guide.

## Local vision runtime

The browser-local VLM is `HuggingFaceTB/SmolVLM-256M-Instruct`, pinned to
revision `7e3e67edbbed1bf9888184d9df282b700a323964`. It runs with
`@huggingface/transformers` 3.7.1 and ONNX Runtime Web in a dedicated worker
inside an offscreen extension document. The model is packaged as q4f16 ONNX
sessions; no Hub request is made during normal operation.

The packaged worker uses WebGPU only when the adapter has `shader-f16`.
Otherwise it uses the local WASM runtime. A failed WebGPU initialization falls
back to WASM. If neither backend can initialize, the worker returns
`LOCAL_VISION_UNAVAILABLE`; `AgentLoop` then uses the existing privacy-gated
server path. It never silently substitutes a remote inference API.

The model and runtime are intentionally kept out of the content-script bundle.
The content script supplies a bounded local screenshot/metadata observation;
the offscreen worker owns the model session and keeps it warm across cycles.
Raw screenshots and raw page text never enter the server payload.

**The local vision model performs inference inside the browser. Server
reasoning is an escalation path for tasks that cannot be safely or reliably
completed locally.**

## Building the extension

Install JavaScript dependencies, then build the content bundle as usual:

```bash
npm install
npm run build:content
```

The SmolVLM weights are not committed. To fetch them and prepare the pinned
assets in a clean checkout, run the network-enabled build-time preparation
step before building the worker:

```bash
npm run prepare:local-vlm-assets
npm run build:local-vlm
```

`prepare:local-vlm-assets` is a build-time operation and is never called by the
extension. It downloads the pinned revision and writes
`extension/local_agent/models/model_manifest.json`; `build:local-vlm` then
verifies every downloaded file's size and SHA-256 digest against that manifest,
bundles the worker, copies the local ONNX Runtime JS/WASM assets, and writes
`BUILD_INFO.json`.

Everything that build produces is ignored by git: the weights, the runtime, the
worker bundle, and `BUILD_INFO.json`. What is tracked is the worker source
under `extension/local_agent/`, the build and download scripts, and the model
pin those scripts assert, so a fresh clone reproduces the same artifact without
the binary payload in history. The normal `npm test` command does not download
model weights.

If the model assets are intentionally not present in a checkout, the runtime
reports `LOCAL_VISION_UNAVAILABLE` and safely abstains; it does not fall back to
a CDN or a server model. That is the expected behaviour of `npm test` on a
fresh clone, and the local vision tests skip themselves.

### After editing background code, reload the extension

`npm run build:content` regenerates `extension/content/content_bundle.js`, which
only carries the content-side scripts. The planner and the action loop live in
`extension/background/` and are loaded as a module service worker straight from
source, so building does not pick up a change to them. A change to anything
under `extension/background/` takes effect only after the extension itself is
reloaded: press reload on `chrome://extensions` for this extension, then
hard-refresh the tab that is being automated. A page refresh alone is not
enough, because the old worker is still running.

The symptom of a forgotten reload is that a test passes and the edited code
never runs in the browser: the popup shows the previous behaviour.

## Running the backend

The backend reads environment variables first and then loads the repository
`.env` file when present. If no provider is explicitly selected, it infers the
provider from an available API key; otherwise it is `disabled`. The mock
planner is an explicit test-only choice and is never selected silently.

```bash
# From the repository root
PYTHONPATH=server uvicorn app.main:app --reload --port 8000
```

The extension defaults to `http://localhost:8000`. Check the active provider
with:

```bash
curl http://localhost:8000/health
```

For a deterministic action-loop test only, explicitly select the mock planner:

```bash
VLM_PROVIDER="mock" PYTHONPATH=server uvicorn app.main:app --reload --port 8000
```

The mock still receives only the extension's gated/redacted context. Do not use
it as the normal production planner.

For real escalation, use a rotated provider key and a supported vision model.
The current Groq default is `qwen/qwen3.8-27b`; verify
that your project has access to it before expecting server actions.

For an explicit OpenAI-compatible provider, set:

```bash
export VLM_PROVIDER="openai"       # or groq, gemini, ollama, custom
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-4o-mini"
export REAL_VLM_ENABLED="true"
```

The local vision path is independent of the backend. A successful local action
makes zero backend requests. A local abstention runs the browser privacy
pipeline before any server request.

## Action and secret rules

Local and server plans use the same JavaScript validator and the same
`EXECUTE_VALIDATED_ACTION` executor. The safe action types are `click`,
`focus`, `scroll`, `select`, `wait`, `keypress`, `type_local`, and `done`.
Model output is grounded to an existing visible/enabled element ID; stale IDs
may be re-grounded only through a unique semantic/geometry match. Arbitrary
selectors, coordinates, JavaScript, executable arguments, and invented targets
are rejected. `keypress` accepts only `Enter`, `Escape`, `Tab`, `ArrowUp`, and
`ArrowDown`; an empty target means the active editable control.

Secret values are never part of a model prompt, action plan, log, or broadcast.
A model may request only an allowed local `secret_ref` such as `email`,
`username`, `phone`, or `password`; the content-script provider resolves it
locally. Ordinary local typing remains handled by the deterministic planner.

Ordinary task text is never typed into a search, filter, or find field. A
deliberate search goal is the single exception, and only for its own query: the
goal must name a query, the target must be a real search control, and the text
must equal that query exactly. The agent searches the page it is already on and
never navigates to a URL of its own.

## Building and testing

Build the content bundle before running JavaScript tests:

```bash
npm run build:content
npm test
```

Run the complete server suite separately:

```bash
PYTHONPATH=server python -m pytest server/tests -v
```

The action-layer tests use dependency-injected runtimes to verify policy,
validation, privacy, lifecycle, zero-backend behavior, and fallback semantics.
`tests/test_action_grounding.js` and `tests/test_spa_action_layer.js` cover
one-action execution, semantic/geometry re-grounding, contenteditable entry,
allowlisted keypress, stale targets, ambiguous targets, and completion checks.
The browser fixtures `evaluation/test_pages/spa_task.html` and
`evaluation/test_pages/messaging_spa.html` cover dynamic composer mounting,
list rerendering, duplicate controls, failed submission state, Enter-to-submit,
and generic contenteditable messaging.
Run the opt-in real-browser smoke test when the packaged assets and Chromium
are available:

```bash
npm run test:local-vlm
```

It performs two real local inferences, verifies session reuse, checks the
shared action validator, and fails if the worker makes an HTTP(S) request.
The generated worker has also been smoke-tested in Chromium against the
packaged q4f16 sessions on the WASM backend; a real WebGPU run requires a
browser adapter with `shader-f16`.

To run the real provider smoke test, provide a valid provider key and
explicitly opt in:

```bash
PYTHONPATH=server REAL_VLM_ENABLED=true OPENAI_API_KEY="$OPENAI_API_KEY" \
  python -m pytest server/tests/test_openai_vlm.py -v
```

Do not log or commit provider credentials. Rotate any credential that has been
exposed in a shell, `.env` file, or diagnostic output.
