# Architecture

For the complete end-to-end workflow and debugging guide, see [WORKFLOW.md](./WORKFLOW.md).

The system is **local-first**. It keeps the deterministic `LocalAgent`, adds a
real browser-local vision-language reasoner, and retains the sanitized server VLM
as an escalation path:

```text
User Goal
   ↓
AgentLoop
   ↓
Deterministic LocalAgent
   ├── LOCAL → shared action validator → target checks → EXECUTE_VALIDATED_ACTION
   │
   └── SERVER / visually ambiguous
       ↓
   LocalVisionAgent
       ├── LOCAL → shared action validator → target checks → EXECUTE_VALIDATED_ACTION
       │                                      ↓
       │                                  Structured Plan
       │
       └── ABSTAIN / LOCAL_VISION_UNAVAILABLE
               ↓
       Existing privacy pipeline
       DOM → screenshot → PII/OCR detection → redaction → verification
               ↓
       Privacy Gate → sanitized context only → FastAPI → server VLM
```

**The local vision model performs inference inside the browser. Server reasoning
is an escalation path for tasks that cannot be safely or reliably completed
locally.**

## Deterministic local planner

`extension/background/local_agent.js` remains the first planner. Its bounded,
deterministic policy handles exact visible controls, ordinary local typing,
local secret references, scrolling, and short safe sequences. It does not load a
model and does not contact the backend on a local success. For task/note goals
it can expose only the currently available step (for example, open a dynamic
composer), allowing the loop to re-observe before the next step.

A deterministic result is always passed through the existing
`validateActionPlan()` function in `extension/background/api_client.js` and the
existing `EXECUTE_VALIDATED_ACTION` executor. It cannot emit JavaScript, CSS
selectors, shell commands, arbitrary browser APIs, or raw secret values.

## Local vision agent

The additional reasoner is implemented in:

- `extension/background/local_vision_agent.js` — bounded policy, grounding,
  target checks, and abstention.
- `extension/background/local_vision_runtime.js` — MV3 offscreen-document
  client.
- `extension/local_agent/local_vision_offscreen.js` — one reusable offscreen
  document and worker bridge.
- `extension/local_agent/local_vlm_worker.js` — the actual Transformers.js
  worker source.
- `extension/local_agent/local_vlm_worker.bundle.js` — generated browser bundle.
- `extension/local_agent/local_vision_protocol.js` — pure prompt, parsing, and
  metadata-safety helpers.

The model is `HuggingFaceTB/SmolVLM-256M-Instruct`, pinned to revision
`7e3e67edbbed1bf9888184d9df282b700a323964`. The extension packages the
Transformers.js 3.7.1 browser worker, ONNX Runtime Web assets, and q4f16 ONNX
sessions under `extension/local_agent/`. Normal inference does not fetch model
weights or runtime code. `allowRemoteModels` is disabled and the worker rejects
non-extension fetches.

The worker receives a bounded local input containing the user goal, sanitized
DOM metadata, a local screenshot, optional local OCR hints, element IDs, and
bounding boxes. The 256M model is intentionally treated as a small visual
labeler: it identifies the best visible target, and the extension grounds that
label to one existing element before producing the strict existing action
schema. This constrained post-processing is necessary for reliable output from
a small model; it is not a remote planner and it never bypasses validation.

Accepted local-vision actions are the existing `click`, `focus`, `scroll`,
`select`, `wait`, `keypress`, `type_local`, and `done` types. `type_local` is
restricted to an allowed `secret_ref`; the model cannot create plaintext
password actions.
Every plan must be terminal, bounded, grounded to a currently visible/enabled
ID, and accepted by `validateActionPlan()`. Ambiguous labels, unknown IDs,
malformed output, repeated waits, and model errors abstain safely.

### Runtime lifecycle and backends

Inference runs in a dedicated worker hosted by a persistent offscreen document,
not in the MV3 service worker or the webpage. The worker keeps one processor and
model session alive across cycles and records:

- cold initialization time;
- warm inference time;
- screenshot preprocessing time;
- total local reasoning time;
- loading/ready status;
- `webgpu` or `wasm` backend;
- local inference count; and
- `performance.memory` only when the browser exposes that measurement.

WebGPU is selected only when the adapter exposes the `shader-f16` feature
required by the packaged q4f16 sessions. Otherwise the worker uses the
packaged WASM runtime. A WebGPU initialization/inference failure falls back to
WASM; if both are unavailable, the result is the categorical
`LOCAL_VISION_UNAVAILABLE` status. The model is disposed on an explicit agent
stop rather than being loaded on every cycle.

## Local-first decision boundary

Simple exact tasks are solved by `LocalAgent` without a screenshot. Visually
ambiguous but bounded tasks are offered to the local vision worker first. A
complex comparison, general research, or multi-step planning goal is skipped
by the small local model and follows the server path. A local vision success
does not call `PRIVACY_PIPELINE` or `APIClient.plan()` because no page data
leaves the browser.

## Privacy boundary

1. The deterministic planner receives only local DOM metadata.
2. The local vision worker may receive a raw screenshot because inference stays
   inside the extension. DOM values and password contents are removed or
   tokenized before the prompt, and no model input/output is logged.
3. A local vision action is still bounded by the shared validator, current
   target checks, password guards, and the validated executor.
4. If local vision abstains, the existing server path runs unchanged:
   screenshot/PII/OCR detection, visual and DOM redaction, verification, and
   the fail-closed Privacy Gate.
5. Only the redacted screenshot and sanitized DOM from that verified pipeline
   are sent to FastAPI. Raw screenshots, raw PII, local secrets, and model
   diagnostics never cross the server boundary.

The server VLM and MockVLM remain supported. The local vision layer is an
additional browser-local reasoning tier, not a replacement for either one.

## Backend and action contract

The FastAPI backend accepts only sanitized context. It routes that context to
the existing VLM provider (`MockVLMProvider`, OpenAI-compatible providers, or
the configured fallback). Server plans use the same action allowlist and
`validateActionPlan()` boundary as local plans.

The action schema remains canonical:

```json
{
  "actions": [
    { "type": "click", "target": "element_17", "args": {} },
    { "type": "done", "target": "", "args": {} }
  ]
}
```

The action layer is a cursor-based executor: a bounded plan may contain several
actions, but `AgentLoop` executes at most one per observation. It re-resolves
stable IDs and unique semantic/geometry hints against a fresh DOM after every
action, uses bounded polling for newly mounted controls, and verifies a
terminal task postcondition before accepting `done`. Stale or ambiguous targets
are replanned rather than guessed or blindly replayed.

No iframe, shadow-root, arbitrary selector, JavaScript, shell, or arbitrary
browser-API support was added.
