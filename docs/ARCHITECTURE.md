
# Architecture

WebGPU is preferred for supported local vision models, but OCR currently uses a WASM backend through Tesseract.js. The OCR provider is abstracted so a WebGPU implementation can be added later.

## Pipeline
1. Screenshot capture (event-driven, offscreen canvas)
2. Preprocessing (crop, resize)
3. Local OCR Abstraction -> Tesseract.js/WASM
4. Structured OCR Results (text, bbox, confidence)
