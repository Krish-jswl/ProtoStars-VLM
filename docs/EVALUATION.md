
# Evaluation and Benchmarking

## Phase 8A: Metrics Engine
Implemented a JSDOM-based metrics engine measuring:
- PII Precision/Recall/F1
- Redaction Coverage and IoU
- Context Preservation

## Phase 8B: Detector Improvements
Improved DOM semantic analysis to include non-interactive visible text nodes. Added an OCR Trigger Policy to conditionally fire OCR on canvas/image-heavy pages.

## Phase 8C: E2E Playwright Tests
Implemented real-browser testing using Playwright's persistent context. 
- Verifies privacy guarantees at the network layer.
- Asserts that actions and local secrets function end-to-end.

See `docs/PLAYWRIGHT_STATUS.md` for execution instructions (requires Xvfb).
