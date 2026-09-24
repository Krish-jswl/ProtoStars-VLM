
# Playwright Integration Status

## Phase 8C Update: E2E Suite Implemented

A complete end-to-end test suite is implemented in `tests/e2e/test_extension.spec.js`.

The suite tests:
1. Extension loads successfully in Chromium.
2. Network interceptions verify sanitized DOM payloads.
3. Known synthetic PII never leaks to the network.
4. Privacy Gate blocks unsafe contexts.
5. OCR trigger policy works on canvas elements.

### Environment Requirement
The tests **REQUIRE** a display server because Chromium does not support loading extensions (`--load-extension`) in headless mode.

### How to Run

**Option A (GUI Environment):**
```bash
npx playwright test
```

**Option B (Headless CI / Container via Xvfb):**
```bash
sudo apt-get install -y xvfb
xvfb-run npx playwright test
```

If you run the tests without Xvfb in a headless container, Chromium will fail to launch with the extension.
