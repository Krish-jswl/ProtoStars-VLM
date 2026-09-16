
# Architecture

WebGPU is preferred for supported local vision models, but OCR currently uses a WASM backend through Tesseract.js. The OCR provider is abstracted so a WebGPU implementation can be added later.

## Observe → Reason → Act Loop

OBSERVE
↓
LOCAL PRIVACY PIPELINE
 → DOM Analysis
 → Screenshot Capture
 → OCR (event-driven)
 → PII Detection + Fusion
 → Redaction (opaque visual + DOM token replacement)
↓
PRIVACY GATE (fail-closed)
↓
SANITIZED CONTEXT (no PII)
↓
POST /v1/agent/plan → FastAPI Backend
↓
VLM PROVIDER (MockVLM / future real provider)
↓
STRUCTURED ACTION PLAN
↓
LOCAL ACTION VALIDATOR
 → action type in allowlist
 → target exists in DOM
 → target visible and enabled
 → re-check freshness before execution
↓
BROWSER EXECUTOR
↓
OBSERVE AGAIN

**The backend never receives raw browser context.**

**The server proposes actions, but the browser is the final authority.**

The network layer must never receive raw page context.

## Privacy Invariants
- If privacy gate returns allowed=false → zero network traffic.
- All PII regions are replaced with opaque black boxes before image leaves device.
- DOM sensitive text is replaced with semantic tokens [TYPE_N] before leaving device.
- type_local actions resolve secrets locally; the server only receives a secret_ref name.
