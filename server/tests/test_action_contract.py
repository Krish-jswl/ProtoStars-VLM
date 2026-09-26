import pytest
from pydantic import ValidationError

from app.schemas import Action, PlanResponse


def test_keypress_contract_accepts_allowlisted_key_and_empty_target():
    action = Action(type="keypress", target="", args={"key": "Enter"})
    assert action.target == ""
    assert action.args["key"] == "Enter"


@pytest.mark.parametrize("key", ["Shift", "Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "Backspace"])
def test_keypress_contract_rejects_non_allowlisted_keys(key):
    if key in {"Enter", "Escape", "Tab", "ArrowUp", "ArrowDown"}:
        action = Action(type="keypress", args={"key": key})
        assert action.args["key"] == key
    else:
        with pytest.raises(ValidationError):
            Action(type="keypress", args={"key": key})


def test_keypress_contract_rejects_extra_arguments():
    with pytest.raises(ValidationError):
        Action(type="keypress", args={"key": "Enter", "code": "process"})


def test_plan_length_and_terminal_marker_are_bounded():
    with pytest.raises(ValidationError):
        PlanResponse(actions=[Action(type="done") for _ in range(13)])
    with pytest.raises(ValidationError):
        PlanResponse(actions=[
            Action(type="done"),
            Action(type="click", target="submit"),
        ])


def test_action_targets_cannot_be_css_selectors():
    with pytest.raises(ValidationError):
        Action(type="click", target="button.primary")
    with pytest.raises(ValidationError):
        Action(type="click", target="body")
    assert Action(type="click", target="submit-button").target == "submit-button"
