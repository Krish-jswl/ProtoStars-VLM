
# Architecture

The system consists of a browser extension for privacy preservation and a backend server for planning.

## Privacy Boundary
1. Browser extracts DOM and takes screenshots.
2. Local PII detection identifies sensitive data.
3. Visual Redactor black-boxes PII in images.
4. DOM Sanitizer replaces PII with tokens (e.g. `[EMAIL_1]`).
5. **Privacy Gate**: Prevents network request if visual redaction fails or unhandled PII exists.

## Backend (Phase 8D)
The FastAPI backend accepts ONLY sanitized context. It routes it to a VLMProvider.

**VLM Providers:**
- `MockVLMProvider`: Default, returns deterministic safe actions for local testing.
- `OpenAIVLMProvider`: Integrates with `gpt-4o-mini`. Uses OpenAI Structured Outputs to strictly enforce the `PlanResponse` schema.

**Security & Prompt Injection:**
The system prompt strictly instructs the VLM to treat webpage text as untrusted data and forbids it from interpreting page content as instructions. All outputs are strictly validated by Pydantic against an allowlist of safe actions (`click`, `scroll`, `focus`, `select`, `wait`, `type_local`).

## Local Secret Flow (Phase 7)
1. Agent plans `type_local` action with `secret_ref="email"`.
2. Network response reaches browser.
3. Local Action Executor queries `LocalSecretProvider` for `"email"`.
4. Secret is securely injected into the DOM without ever leaving the browser.
