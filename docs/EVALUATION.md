# Evaluation and Benchmarking

## Local vision decision path

The evaluation target is the following bounded path:

```text
User Goal
   ↓
Deterministic LocalAgent
   ↓
Local Vision/Reasoning (inside the browser)
   ├── safe grounded action → local execution
   └── abstain/unavailable → existing Privacy Gate → server VLM
```

**The local vision model performs inference inside the browser. Server
reasoning is an escalation path for tasks that cannot be safely or reliably
completed locally.**

A local vision success is evaluated as a privacy-preserving fast path: the
synthetic-page test asserts that the validated action reaches the page and that
the backend request count is zero. A local abstention is evaluated only after
the existing DOM/PII/OCR/redaction/verification path has allowed a sanitized
request. A raw screenshot is never included in the recorded server payload.

## Local-vision measures

The worker records measurements without logging image contents, prompts, DOM
values, or model output:

- cold model initialization time;
- warm inference time;
- screenshot preprocessing time;
- total local reasoning time;
- model loading status (`loading`, `ready`, `unavailable`, or `disposed`);
- selected backend (`webgpu` or `wasm`);
- number of local inferences; and
- `performance.memory.usedJSHeapSize` only when `performance.memory` is
  available.

A missing browser memory API is reported as unavailable rather than replaced
by an estimate. WebGPU measurements are kept separate from WASM measurements;
they must not be compared as if they represented the same backend.

The packaged q4f16 model is approximately 194 MB of ONNX payload plus a small
tokenizer/metadata set. Runtime WASM assets are packaged separately. These are
real measurements of the shipped artifact, not a claim about every device.

## Test matrix

`tests/test_local_vision_agent.js` covers:

1. model/runtime availability and safe initialization failure;
2. one runtime/session reused across inferences;
3. screenshot and OCR handoff;
4. a structured grounded local action;
5. shared action-validator acceptance;
6. zero backend requests on local success;
7. complex-task escalation;
8. server escalation only after the privacy gate;
9. raw screenshot exclusion from the server context;
10. no raw PII in model metadata or broadcasts;
11. WebGPU/WASM fallback status;
12. terminal `done` handling; and
13. repeated-wait rejection.

The actual generated worker is built from
`extension/local_agent/local_vlm_worker.js` and is smoke-tested in Chromium with
the packaged model on WASM. A WebGPU smoke test must use a browser exposing
`shader-f16`; otherwise the expected result is the documented WASM fallback,
not a server model.

## Existing privacy evaluations

The existing metrics engine measures:

- PII precision/recall/F1;
- redaction coverage and IoU;
- context preservation; and
- browser/network privacy behavior.

The local vision tier does not weaken those checks. It receives a local-only
observation, and any server escalation still uses the already-redacted context.
