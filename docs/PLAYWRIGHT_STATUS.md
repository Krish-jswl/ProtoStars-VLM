
# Playwright Integration Status

## Current Status: NOT YET IMPLEMENTED

Chrome extension loading in Playwright requires:
- `chromium.launchPersistentContext()` with `--load-extension` flag
- Extensions cannot be loaded in headless mode (Chromium limitation)
- Requires a display server or Xvfb for CI

## Plan
When implemented, Playwright tests will verify:
- Extension loading
- DOM extraction in real browser
- Screenshot capture
- Action execution
- Privacy gate blocking network
- type_local insertion
- Navigation/state change

## Workaround
Current tests use JSDOM for unit/integration testing.
Network privacy is verified via payload serialization checks.
Visual redaction is verified via MockCanvas pixel checks.
