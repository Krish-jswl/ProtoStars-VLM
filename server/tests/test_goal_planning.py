from fastapi.testclient import TestClient

import app.main as main_module
from app.main import app
from app.schemas import Action, PlanResponse


client = TestClient(app)


def context(goal: str, dom: list[dict]) -> dict:
    return {
        "goal": goal,
        "page": {
            "url": "https://example.test/notes",
            "title": "Notes",
            "viewport": {"width": 1024, "height": 768},
        },
        "dom": dom,
        "image": "data:image/jpeg;base64,redacted",
    }


def node(node_id: str, tag: str, **values):
    payload = {
        "id": node_id,
        "tag": tag,
        "bbox": {"x": 0, "y": 0, "width": 120, "height": 32},
        "visible": True,
        "enabled": True,
    }
    payload.update(values)
    return payload


def test_note_goal_returns_executable_json_actions():
    payload = context(
        'add a note named "hello" and click save',
        [
            node("note-title", "input", inputType="text", placeholder="Note title"),
            node("save-note", "button", text="Save note"),
        ],
    )

    response = client.post("/v1/agent/plan", json=payload)

    assert response.status_code == 200
    actions = response.json()["actions"]
    assert actions == [
        {"type": "type_local", "target": "note-title", "args": {"text": "hello"}},
        {"type": "click", "target": "save-note", "args": {}},
        {"type": "done", "target": "", "args": {}},
    ]


def test_task_goal_with_add_submit_button_is_terminal():
    payload = context(
        'add a task named "Run"',
        [
            node("task-title", "input", inputType="text", placeholder="Task title"),
            # This UI uses one "Add task" control as the submit action.
            node("add-task", "button", text="Add task"),
        ],
    )

    response = client.post("/v1/agent/plan", json=payload)

    assert response.status_code == 200
    actions = response.json()["actions"]
    assert [action["type"] for action in actions] == ["type_local", "click", "done"]
    assert actions[-1] == {"type": "done", "target": "", "args": {}}


def test_task_goal_can_use_enter_when_no_submit_control_is_visible():
    payload = context(
        'add a task named "Run" with Enter',
        [
            node(
                "title",
                "div",
                inputType="contenteditable",
                role="textbox",
                ariaLabel="Task title",
            )
        ],
    )

    response = client.post("/v1/agent/plan", json=payload)

    assert response.status_code == 200
    actions = response.json()["actions"]
    assert [action["type"] for action in actions] == ["type_local", "keypress", "done"]
    assert actions[1]["args"] == {"key": "Enter"}


def test_notion_style_contenteditable_task_does_not_reclick_global_new():
    payload = context(
        'add a task named "Run"',
        [
            node("new", "button", text="New"),
            node(
                "title",
                "div",
                inputType="contenteditable",
                role="textbox",
                ariaLabel="Title",
            ),
        ],
    )

    response = client.post("/v1/agent/plan", json=payload)

    assert response.status_code == 200
    actions = response.json()["actions"]
    assert [action["type"] for action in actions] == ["type_local", "done"]
    assert actions[0]["args"]["text"] == "Run"
    assert not any(action["target"] == "new" for action in actions)


def test_login_goal_returns_only_local_secret_refs():
    payload = context(
        "log in to my account",
        [
            node("email", "input", inputType="email", autocomplete="email"),
            node("password", "input", inputType="password"),
            node("login", "button", text="Log in"),
        ],
    )

    response = client.post("/v1/agent/plan", json=payload)

    assert response.status_code == 200
    actions = response.json()["actions"]
    assert [action["type"] for action in actions] == ["type_local", "type_local", "click", "done"]
    assert actions[0]["args"] == {"secret_ref": "email"}
    assert actions[1]["args"] == {"secret_ref": "password"}
    assert all("value" not in action.get("args", {}) for action in actions)


def test_unavailable_vlm_uses_safe_local_fallback(monkeypatch):
    class FailedProvider:
        async def analyze(self, context):
            return PlanResponse(
                actions=[Action(type="wait", args={"reason": "VLM provider forbidden (HTTP 403)"})]
            )

    monkeypatch.setattr(main_module, "provider", FailedProvider())
    monkeypatch.setattr(main_module.settings, "vlm_provider", "groq")
    monkeypatch.setattr(main_module.settings, "vlm_fallback_to_mock", True)

    payload = context(
        'add a note named "hello" and click save',
        [
            node("note", "input", inputType="text", placeholder="Note title"),
            node("save", "button", text="Save"),
        ],
    )
    response = client.post("/v1/agent/plan", json=payload)

    assert response.status_code == 200
    assert [action["type"] for action in response.json()["actions"]] == [
        "type_local",
        "click",
        "done",
    ]


def test_composite_login_task_goal_never_targets_password_with_task_text():
    payload = context(
        'login and add a task named as "Run"',
        [
            node("email", "input", inputType="email"),
            node("password", "input", inputType="password"),
            node("task-title", "input", inputType="text", placeholder="Task title"),
            node("save-task", "button", text="Save task"),
        ],
    )

    response = client.post("/v1/agent/plan", json=payload)

    assert response.status_code == 200
    actions = response.json()["actions"]
    assert any(action["target"] == "password" and action["args"].get("secret_ref") == "password" for action in actions)
    assert not any(
        action["target"] == "password" and action["args"].get("text") == "Run"
        for action in actions
    )

