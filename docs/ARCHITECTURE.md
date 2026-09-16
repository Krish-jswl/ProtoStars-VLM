
# Architecture

WebGPU is preferred for supported local vision models, but OCR currently uses a WASM backend through Tesseract.js. The OCR provider is abstracted so a WebGPU implementation can be added later.

## Privacy Boundary

RAW PAGE DATA
↓
LOCAL DETECTION
↓
LOCAL REDACTION
↓
LOCAL VERIFICATION
↓
PRIVACY GATE
↓
SANITIZED CONTEXT
↓
[future network request]

The network layer must never receive raw page context.
