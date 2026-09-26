# Privacy Vision Agent: End-to-End Workflow and Architecture

This document describes the complete browser-extension → backend → browser-action loop, including the privacy boundary, request/response formats, local secret handling, retries, fallback behavior, and troubleshooting.

---

## 1. High-level flow

```text
User enters a goal in the extension popup
             │
             ▼
   MV3 background service worker
             │
             │ START_GOAL_AGENT
             ▼
       AgentLoop (local-first observe/reason/act)
             │
             ├── LocalAgent reads ANALYZE_DOM locally
             │       │
             │       ├── LOCAL → shared validator → EXECUTE_VALIDATED_ACTION
             │       │                                  ↓
             │       │                           Structured Plan
             │       │
             │       └── SERVER / visually ambiguous
             │                    │
             │                    ▼
             │             LocalVisionAgent
             │                    │
             │                    ├── LOCAL → shared validator → validated execution
             │                    │
             │                    └── ABSTAIN / LOCAL_VISION_UNAVAILABLE
             │                              │
             │                              ▼
             │                       PRIVACY_PIPELINE
             │                              │
             │                              ├── PII detection/redaction
             │                              ├── OCR when selectively triggered
             │                              ├── Privacy Gate
             │                              └── Sanitized context only
             │                                       │
             │                                       │ POST /v1/agent/plan
             │                                       ▼
             │                                 FastAPI backend
             │                                       │
             │                                       ├── Select VLM_PROVIDER
             │                                       ├── Send sanitized context
             │                                       └── Parse/validate actions
             │
             └── AgentLoop validates targets and executes allowlisted actions
                         │
                         ├── click/focus/scroll/select/wait/keypress
                         ├── type_local (ordinary text or local reference)
                         └── done (handled by background loop)
```

The backend never directly controls the browser. It only returns a JSON plan when the deterministic and local-vision planners abstain. The extension is the component that executes both local and server-returned actions, and either local success path creates zero backend requests.

---

## 2. Main components

| Component | File | Responsibility |
|---|---|---|
| Popup UI | `extension/popup/popup.js` | Collects the user's goal and local secret values, starts/stops the agent |
| Background service worker | `extension/background/service_worker.js` | Starts agent loops, captures screenshots, resumes after navigation |
| Agent loop | `extension/background/agent_loop.js` | Local-first observe → plan → validate → execute → repeat |
| Local agent | `extension/background/local_agent.js` | Deterministic LOCAL/SERVER classification and simple local plans |
| Local vision adapter | `extension/background/local_vision_agent.js` | Bounded model policy, target grounding, validation, and abstention |
| Offscreen VLM bridge | `extension/background/local_vision_runtime.js`, `extension/local_agent/local_vision_offscreen.js` | Routes one local inference session through an MV3 offscreen document |
| Local VLM worker | `extension/local_agent/local_vlm_worker.js` | Actual Transformers.js/ONNX Runtime Web inference; packaged model and runtime assets |
| Shared action validator | `extension/background/api_client.js` (`validateActionPlan`) | Validates both local and server-generated action plans |
| Target grounding | `extension/background/action_grounding.js` | Re-resolves IDs and unique semantic/geometry targets after SPA rerenders |
| API client | `extension/background/api_client.js` | Sends sanitized context and validates/normalizes backend JSON |
| Content script entry | `extension/content/content_main.js` | Receives messages from the background worker |
| Generated content bundle | `extension/content/content_bundle.js` | Actual content script loaded by `manifest.json` |
| Privacy pipeline | `extension/content/privacy_pipeline_runner.js` | Coordinates DOM, screenshot, redaction, gate, and action execution |
| DOM analyzer | `extension/content/dom_analyzer.js` | Extracts safe element metadata and stable IDs |
| PII detector | `extension/privacy/pii_detector.js` | Detects email, phone, name, password, Aadhaar, PAN, address, card, and auth-token patterns |
| Redactor | `extension/privacy/redactor.js` | Replaces DOM values and black-boxes screenshot regions |
| Privacy gate | `extension/privacy/privacy_gate.js` | Blocks the request if redaction is incomplete |
| Secret provider | `extension/privacy/secret_provider.js` | Keeps email/password/username/phone values locally |
| Backend API | `server/app/main.py` | FastAPI endpoint, provider setup, CORS, payload limit, fallback |
| Request/response schemas | `server/app/schemas.py` | Validates sanitized context and safe action JSON |
| Mock planner | `server/app/providers/mock_vlm.py` | Deterministic offline planner for simple goals |
| VLM planner | `server/app/providers/openai_vlm.py` | OpenAI/Groq/Gemini/Ollama-compatible planner |

---

## 3. Privacy boundary

The browser is the privacy boundary. The extension must complete all sensitive-data handling before making the backend request.

### Local processing

For a deterministic LOCAL decision, the extension reads DOM metadata locally, validates the deterministic plan, and executes it without creating a backend request. No screenshot or page payload is sent. When the popup starts a task, it requests a separate **local privacy preview** first; this preview performs DOM/OCR PII detection and redaction locally so the popup can show detections and a redacted screenshot without making a server request.

When the deterministic planner abstains, `AgentLoop` asks the local vision worker for a bounded visual reason. The worker receives a local screenshot, sanitized DOM metadata, optional OCR hints, IDs, and bounding boxes. Its target label is grounded to an existing element, then the same validator and `EXECUTE_VALIDATED_ACTION` path are used. A local vision success also creates zero backend requests. The model output, screenshot, and local diagnostics are never sent to FastAPI.

For a SERVER escalation, the extension:

1. Reads DOM metadata and element bounding boxes.
2. Captures the active tab locally.
3. Detects sensitive values locally.
4. Replaces sensitive DOM text/value fields with semantic tokens such as:
   - `[EMAIL_1]`
   - `[PHONE_1]`
   - `[PASSWORD_1]`
   - `[PERSON_1]`
   - `[AADHAAR_1]`
5. Draws black rectangles over sensitive screenshot regions.
6. Runs the privacy gate.
7. Sends the request only if the gate allows it.

The outgoing DOM does not include raw input values. It contains sanitized text and safe structural metadata.

### What is sent to the backend

The backend receives a sanitized context similar to:

```json
{
  "goal": "Login and add a task named \"Study GOC\"",
  "page": {
    "url": "https://example.com/tasks",
    "title": "Tasks",
    "viewport": {
      "width": 1440,
      "height": 900
    }
  },
  "dom": [
    {
      "id": "task-title",
      "tag": "input",
      "role": "",
      "text": "",
      "inputType": "text",
      "autocomplete": "",
      "placeholder": "Task title",
      "ariaLabel": "Task title",
      "name": "taskTitle",
      "label": "Task title",
      "options": [],
      "bbox": {
        "x": 40,
        "y": 180,
        "width": 320,
        "height": 40
      },
      "visible": true,
      "enabled": true
    }
  ],
  "image": "data:image/jpeg;base64,<locally-redacted-image>"
}
```

The image is already redacted before `JSON.stringify()` is called.

### What is not sent

Raw values such as these do not cross the network boundary:

- Email addresses
- Passwords
- Phone numbers
- Names detected by the local PII pipeline
- Aadhaar numbers
- PAN/card numbers
- Authentication tokens
- Local secret values entered in the popup

The backend performs additional validation as defense in depth, but it is not responsible for redacting the page.

---

## 4. Starting the agent

The popup sends a message to the service worker:

```json
{
  "type": "START_GOAL_AGENT",
  "tabId": 123,
  "goal": "Login and add a task named \"Study GOC\""
}
```

The service worker creates an `AgentLoop` for that tab.

The popup stores credential references locally and sends them separately to the content script:

```json
{
  "type": "SET_SECRETS",
  "secrets": {
    "email": "local-value",
    "password": "local-value"
  }
}
```

Those values are never included in `/v1/agent/plan`.

---

## 5. DOM observation

`DOMAnalyzer` collects interactive elements and relevant text elements.

For each element it can provide:

- Safe/generated `id`
- Tag and ARIA role
- Sanitized text
- Input type
- Autocomplete hint
- Placeholder
- ARIA label
- Form field name
- Associated label text
- Select options
- Bounding box
- Safe ARIA state (`expanded`, `selected`, `checked`, `current`, `pressed`, `haspopup`)
- Visibility and enabled state

If an element has no ID, the extension creates a stable `pva-*` ID so the backend can return an executable target.

Off-screen controls are retained in the observation. Before clicking or focusing one, the executor scrolls it into view.

The current implementation observes the top document. Iframes and closed shadow roots require additional frame/element-reference handling and are not currently supported.

---

## 6. Local vision reasoning

The local vision tier is attempted only after `LocalAgent` returns `SERVER` for
a bounded, non-complex goal. `extension/content/privacy_pipeline_runner.js`
captures a local screenshot and returns bounded metadata for the worker. The
worker uses the packaged SmolVLM-256M q4f16 sessions in a dedicated worker
under an offscreen document.

The worker lifecycle is:

```text
initialize once → reuse processor/model session → infer → record metrics
                         ↓
                 explicit stop/dispose
```

WebGPU is used when the adapter exposes `shader-f16`; otherwise the worker uses
WASM. Initialization or inference failure produces the categorical
`LOCAL_VISION_UNAVAILABLE` result and returns to the existing privacy pipeline.
The worker disables remote model loading, browser model caching, and remote
fetches. It does not log image contents, prompts, DOM values, or raw model
output.

The model's compact visual answer is grounded deterministically to one current
element ID. The resulting actions are still passed through
`validateActionPlan()`, target visibility checks, password guards, and
`EXECUTE_VALIDATED_ACTION`. Unknown IDs, ambiguous labels, executable output,
non-terminal plans, and repeated waits abstain rather than executing.

---

## 7. Screenshot capture and redaction

The content script asks the service worker to capture the active tab:

```json
{
  "type": "CAPTURE_TAB"
}
```

The service worker verifies that the requesting tab is still active. This prevents combining DOM coordinates from one tab with a screenshot from another tab.

The image is resized to a maximum width of 1920 pixels. The local redactor draws black rectangles over every planned PII bounding box. The privacy gate checks that the redacted pixels are actually black before allowing the request.

The normal observation path performs cheap DOM PII detection first, then evaluates `OCRTriggerPolicy`. Tesseract OCR is initialized lazily only when a canvas or image-heavy page needs it; the worker is retained across observations. OCR detections are fused with DOM detections before redaction. If required OCR fails, the privacy gate fails closed and no sanitized context is sent.

---

## 8. Backend request

The extension sends:

```http
POST /v1/agent/plan
Content-Type: application/json
X-Request-ID: <request-id>
```

The backend validates:

- Required page, DOM, and image fields
- DOM and image size limits
- Safe action types
- Safe action arguments
- Local secret references
- Common unredacted PII regressions

The backend also supports `screenshot` and `screenshotData` as compatibility aliases for `image`.

---

## 9. Backend provider selection

Provider settings are read from environment variables first and then from the repository `.env` file.

Supported providers:

- `mock`
- `openai`
- `groq`
- `gemini`
- `ollama`
- `custom`

If `VLM_PROVIDER` is not set, the backend infers a provider from an available API key. If no key is available, it uses the deterministic mock provider.

Example explicit configuration:

```bash
export VLM_PROVIDER="groq"
export GROQ_API_KEY="..."
export GROQ_MODEL="<vision-model>"
```

Do not commit real credentials.

---

## 10. Backend JSON action response

The normal response is always an object with an `actions` array:

```json
{
  "actions": [
    {
      "type": "type_local",
      "target": "task-title",
      "args": {
        "text": "Study GOC"
      }
    },
    {
      "type": "click",
      "target": "save-task",
      "args": {}
    },
    {
      "type": "done",
      "target": "",
      "args": {}
    }
  ]
}
```

### Supported action types

| Action | Meaning |
|---|---|
| `click` | Click an existing element |
| `focus` | Focus an existing editable/control element |
| `scroll` | Scroll the page or an element using `x`/`y` |
| `select` | Select a matching `<select>` option |
| `wait` | Wait for a bounded page transition or newly revealed control |
| `keypress` | Dispatch one allowlisted key (`Enter`, `Escape`, `Tab`, `ArrowUp`, `ArrowDown`) to a target or the active editable control |
| `type_local` | Insert ordinary text or resolve a local secret reference |
| `done` | End the agent loop |

JavaScript evaluation, arbitrary scripts, executable arguments, and unknown action types are rejected.

### Secret references

Credentials are represented by references, never values:

```json
{
  "type": "type_local",
  "target": "email",
  "args": {
    "secret_ref": "email"
  }
}
```

The content script resolves the reference locally.

---

## 11. VLM planning and validation

For an external VLM, the backend sends:

- System instructions
- Sanitized goal
- Sanitized page URL/title/viewport
- Sanitized DOM element metadata
- Redacted screenshot

The VLM must return JSON only. The backend:

1. Attempts structured JSON output.
2. Falls back to JSON-object mode if the provider does not support structured output.
3. Parses markdown/plain JSON responses.
4. Removes null arguments.
5. Validates action types.
6. Ensures click/type/select targets correspond to current DOM IDs.
7. Returns a `PlanResponse`.

A provider failure is converted into a safe wait plan rather than leaking provider details or request data.

---

## 12. Deterministic mock provider (explicit opt-in)

The mock planner is for offline development and tests only. It is not used as an automatic fallback in normal operation. If no provider key or explicit provider is configured, the backend now defaults to `disabled` rather than silently selecting mock.

To explicitly enable mock planning for a local test run:

```bash
VLM_PROVIDER=mock PYTHONPATH=. uvicorn app.main:app --reload --port 8000
```

Normal local-first operation does not need this backend. The extension tries the browser deterministic agent first, then the local vision model, and only sends a sanitized request to the configured real backend provider if both local tiers abstain or are unavailable.

If a real provider fails, the default behavior is fail-closed rather than silently switching to the mock planner:

```bash
VLM_FALLBACK_TO_MOCK=false
```

---

## 13. Action execution

The shared `validateActionPlan()` validator checks both local and backend responses before actions reach the page. Local plans use the same `EXECUTE_VALIDATED_ACTION` content-script executor; they do not use the legacy arbitrary-action path.

The background loop then:

1. Checks the action type and bounded plan shape.
2. Resolves the current target by stable ID first, then unique semantic metadata and geometry.
3. Revalidates visibility, enabled/read-only state, editability, and password safety against a fresh DOM observation.
4. Sends exactly one action to the content script.
5. Gives dynamic pages a short settling period and re-observes before considering the next action.
6. Rejects stale/ambiguous targets, re-plans from the new observation, and never blindly replays a click.
7. Accepts `done` only after required postconditions are visible; task/note creation checks for the requested text in a non-editable result element. Wait actions are normalized to 50–5000 ms and bounded across the loop.

The popup exposes the active route as a separate status section: `LOCAL` for deterministic browser rules, `LOCAL VLM` for the on-device screenshot model, `PRIVACY` for local PII/OCR redaction, and `SERVER` when the sanitized planner request is sent to the configured backend provider. Even for a server plan, validated actions are executed back in the browser.

### Ordinary text

For a note/task title:

```json
{
  "type": "type_local",
  "target": "task-title",
  "args": {
    "text": "Study GOC"
  }
}
```

The extension writes the text locally to an input, textarea, or contenteditable element and dispatches input/change events.

Plaintext task/note text is rejected when the target looks like a password field, even if a site has temporarily changed the field to `type="text"` for a show-password control. Password targets must use a local `secret_ref` instead.

### Dynamic SPA task flow

The synthetic fixture at `evaluation/test_pages/spa_task.html` exercises a
Todoist-like flow without site-specific production selectors:

```text
Add task → dynamic composer → contenteditable title → submit/rerender → task result
```

The normal and `?enter=1` modes cover button submission and Enter submission.
The action layer re-observes after every step, so a newly mounted editor is
never assumed to exist in the original snapshot.

`evaluation/test_pages/messaging_spa.html` covers a generic WhatsApp-like
contenteditable message flow using the goal `send a message "hello"`. Message
intent is grounded from generic editor/button semantics, not site selectors.
The loop records a verified draft and a submitted message locally: it types
once, submits once, and performs bounded confirmation polling without replaying
the send when a conversation UI delays exposing the outgoing bubble. If the
outgoing bubble is virtualized, a fresh empty composer after the send action is
accepted as the local UI postcondition. If no labeled send control is available,
a targeted allowlisted Enter is delivered to the grounded editor.

### Local credentials

For login:

```json
{
  "type": "type_local",
  "target": "email",
  "args": {
    "secret_ref": "email"
  }
}
```

The extension resolves `email` or `password` from its local secret provider. The raw value is never sent to the backend.

### Navigation

If a click causes navigation:

1. The current generation is invalidated.
2. The old page cannot execute later actions.
3. The service worker waits for the new page to finish loading.
4. The agent re-observes the new page and continues.

---

### Composite login + task commands

For a command such as:

```text
login and add a task named as "Run"
```

the planner preserves the order:

```text
fill local email secret → fill local password secret → click login
→ fill task field with "Run" → click task save
```

If login navigates to a new page, the agent stops the old cycle and re-observes before attempting the task action. The word `Run` is never used as a password value.

---

## 14. Error and retry behavior

The agent distinguishes between:

- Local success → execute the terminal local plan; no privacy pipeline or backend request
- Local target/action failure → stop safely; do not replay the same local plan
- Privacy gate failure → stop with an error; no backend request
- Backend/provider failure → report an error or use the configured fallback
- Invalid/stale target → reject and re-observe
- Action execution failure → retry/re-observe within a bounded cycle budget
- Explicit `done` → finish successfully
- Maximum cycles reached → report an error if the last cycle failed

A provider error such as `VLM Error` is not a successful action. The extension will not report it as “Goal achieved.”

---

## 15. Troubleshooting

### `VLM Error`

Check:

```bash
curl http://localhost:8000/health
```

If the response says `"provider": "groq"`, the external Groq request is failing. Common causes:

- Invalid or revoked API key
- Groq account/access restrictions
- Network/proxy blocking the provider
- Retired or unavailable vision model
- Provider quota/rate limit

For local development, explicitly use:

```bash
VLM_PROVIDER=mock PYTHONPATH=server \
uvicorn app.main:app --reload --port 8000
```

### `GET /v1/models` returns 404

This is not required by the extension. The backend contract uses:

- `GET /health`
- `POST /v1/agent/plan`

### Extension says content script is not loaded

Reload the extension after rebuilding the content bundle:

```bash
npm run build:content
```

Then reload the extension from `chrome://extensions` and reload the target page.

### Action target is rejected

This usually means:

- The page rerendered after observation
- The model returned a selector instead of an element ID
- The target is inside an unsupported iframe/shadow root
- The control is hidden or disabled

The agent should re-observe and try again.

---

## 16. Build and test

Build the content bundle:

```bash
npm run build:content
```

Run JavaScript tests:

```bash
npm run test:js
```

Run backend tests:

```bash
python -m pytest server/tests -q
```

Run the complete local JavaScript flow:

```bash
npm test
```

Build and verify the packaged local VLM worker separately:

```bash
npm run build:local-vlm
```

The manifest loads `extension/content/content_bundle.js`, not the unbundled source modules. Always rebuild after changing content-script source.

---

## 17. Important current limitations

- Iframes are not currently observed or controlled.
- Open shadow-root controls are not currently traversed.
- OCR is selective; when triggered, an unavailable or malformed OCR result fails closed.
- Synthetic DOM clicks and input events are not trusted browser input events.
- Service-worker state is in memory and can be lost if the extension worker is suspended; the heavy model session is therefore hosted offscreen.
- The local vision model is intentionally small and bounded; complex, ambiguous, or unsafe tasks abstain to the existing server path.
- WebGPU requires `shader-f16` for the packaged q4f16 sessions; WASM is the practical fallback.

These limitations do not change the privacy boundary: the extension still redacts locally before any network request.

---

## 18. Quick mental model

When debugging a command, follow these questions:

1. Did the popup receive a non-empty goal?
2. Did deterministic `LocalAgent` return `LOCAL`, or did it abstain?
3. Did the local vision worker initialize, and did it return a grounded plan or `LOCAL_VISION_UNAVAILABLE`?
4. If local vision abstained, did the content script return `allowed: true`?
5. Was the sanitized context actually sent to `/v1/agent/plan`?
6. What provider did `/health` report?
7. Did the backend return an `actions` array or an error wait?
8. Did each action target exist in the current DOM observation?
9. Did the content script return `success: true` for the action?
10. Did navigation trigger a new observation cycle?

That sequence covers the complete path from user command to executed browser action.
