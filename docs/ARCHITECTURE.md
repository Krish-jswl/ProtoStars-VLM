
# Architecture

WebGPU is preferred for supported local vision models, but OCR currently uses a WASM backend through Tesseract.js. The OCR provider is abstracted so a WebGPU implementation can be added later.

## Observe -> Reason -> Act Loop

OBSERVE
 -> LOCAL PRIVACY PIPELINE
   -> DOM Analysis
   -> Screenshot Capture
   -> OCR (event-driven)
   -> PII Detection + Fusion
   -> Redaction (opaque visual + DOM token replacement)
 -> PRIVACY GATE (fail-closed)
 -> SANITIZED CONTEXT (no PII)
 -> POST /v1/agent/plan -> FastAPI Backend
 -> VLM PROVIDER (MockVLM / future real provider)
 -> STRUCTURED ACTION PLAN
 -> LOCAL ACTION VALIDATOR
   -> action type in allowlist
   -> target exists in DOM
   -> target visible and enabled
   -> re-check freshness before execution
 -> BROWSER EXECUTOR
 -> OBSERVE AGAIN

**The backend never receives raw browser context.**

**The server proposes actions, but the browser is the final authority.**

The network layer must never receive raw page context.

## Local Secret Handling (type_local)

```
            SERVER
               |
               | secret_ref ONLY
               v
      LOCAL ACTION VALIDATOR
               |
               v
      LOCAL SECRET PROVIDER
               |
               v
          TYPE_LOCAL
               |
               v
         BROWSER INPUT
```

**Secret values never cross the privacy boundary.**

- Server sends `{ type: "type_local", target: "element_id", args: { secret_ref: "password" } }`
- Browser resolves `secret_ref` to a locally stored value
- Browser validates target compatibility (input type, visibility, enabled state)
- Browser inserts value with proper DOM events
- Actual secret value NEVER appears in: network requests, logs, telemetry, DOM analyzer output, screenshots, OCR output, error messages, or API payloads

### Allowed Secret References
- `email` -> input[type=email], input[type=text]
- `phone` -> input[type=tel], input[type=text]
- `username` -> input[type=text], input[type=email]
- `password` -> input[type=password] ONLY

### Secret Lifetime
- In-memory only (no persistence to localStorage/IndexedDB)
- Cleared on extension unload or explicit clear() call
- No cloud secret management

## Privacy Invariants
- If privacy gate returns allowed=false -> zero network traffic.
- All PII regions are replaced with opaque black boxes before image leaves device.
- DOM sensitive text is replaced with semantic tokens [TYPE_N] before leaving device.
- type_local actions resolve secrets locally; the server only receives a secret_ref name.
