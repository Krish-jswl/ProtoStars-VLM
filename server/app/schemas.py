"""Schemas for the privacy-preserving agent API.

The extension is the privacy boundary: it must replace sensitive DOM values and
pixels before constructing a request.  The server still validates the shape of
that request and rejects a few obvious raw-PII regressions as defence in depth.
"""

import math
import re
from typing import Any, Dict, List, Optional, Set

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator


MAX_ACTION_PLAN_LENGTH = 12
SAFE_KEYS = {"Enter", "Escape", "Tab", "ArrowUp", "ArrowDown"}


def _luhn_valid(value: str) -> bool:
    digits = re.sub(r"\D", "", value)
    if not 13 <= len(digits) <= 19:
        return False
    total = 0
    alternate = False
    for digit in reversed(digits):
        number = int(digit)
        if alternate:
            number *= 2
            if number > 9:
                number -= 9
        total += number
        alternate = not alternate
    return total % 10 == 0


class Bbox(BaseModel):
    """A DOM bounding box in CSS pixels."""

    model_config = ConfigDict(extra="ignore")

    x: float
    y: float
    # Real pages can contain zero-sized nodes.  They are useful context for the
    # planner, and the extension performs the final visibility check before a
    # target is used.
    width: float = Field(..., ge=0, description="Width cannot be negative")
    height: float = Field(..., ge=0, description="Height cannot be negative")


class DOMNode(BaseModel):
    """Sanitized, privacy-safe element metadata received by the planner.

    Values are deliberately represented as strings rather than arbitrary HTML
    or form values.  The extension must not send a raw input value here.
    """

    model_config = ConfigDict(extra="ignore")

    id: str = ""
    tag: str = ""
    role: str = ""
    text: str = ""
    inputType: str = ""
    # These safe attributes help the planner identify controls on pages that do
    # not put a useful label in an element's text.  They are sanitized by the
    # extension before they are added to the network payload.
    autocomplete: str = ""
    placeholder: str = ""
    ariaLabel: str = ""
    name: str = ""
    title: str = ""
    testId: str = ""
    label: str = ""
    ariaExpanded: str = Field(default="", max_length=20)
    ariaSelected: str = Field(default="", max_length=20)
    ariaChecked: str = Field(default="", max_length=20)
    ariaCurrent: str = Field(default="", max_length=40)
    ariaPressed: str = Field(default="", max_length=20)
    ariaHasPopup: str = Field(default="", max_length=40)
    options: List[str] = Field(default_factory=list, max_length=100)
    bbox: Bbox
    visible: bool = True
    enabled: bool = True
    readOnly: bool = False

    @field_validator("text")
    @classmethod
    def prevent_sensitive_leakage(cls, value: str) -> str:
        """Reject common unredacted values as a server-side safety net.

        This is not the primary privacy mechanism.  The extension's local
        redactor and privacy gate remain authoritative; this check prevents a
        broken client from accidentally making a raw value available to the
        planner.
        """

        if re.search(
            r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", value
        ) and not (value.startswith("[") and value.endswith("]")):
            raise ValueError("Suspicious unredacted email detected by server")

        # A conservative credit-card-shaped value.  The client also applies a
        # Luhn check, so this mainly catches a failed/bypassed local pipeline.
        for candidate in re.findall(r"\b(?:\d[ -]*?){13,19}\b", value):
            if _luhn_valid(candidate):
                raise ValueError("Suspicious unredacted credit card detected by server")

        # Aadhaar is explicitly part of the supported local PII taxonomy.
        if re.search(r"(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)", value):
            raise ValueError("Suspicious unredacted Aadhaar detected by server")

        if re.search(
            r"\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,})",
            value,
        ):
            raise ValueError("Suspicious unredacted authentication token detected by server")

        return value

    @field_validator("autocomplete", "placeholder", "ariaLabel", "name", "label", "title", "testId")
    @classmethod
    def prevent_metadata_sensitive_leakage(cls, value: str) -> str:
        # Metadata is used for labels and should not contain an actual email or
        # card.  Keep this check intentionally narrower than the text check so
        # normal labels such as "Email address" remain useful to the planner.
        if re.search(
            r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", value
        ):
            raise ValueError("Suspicious unredacted email detected in element metadata")
        if re.search(
            r"\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,})", value
        ):
            raise ValueError("Suspicious unredacted authentication token detected in element metadata")
        return value

    @field_validator("options")
    @classmethod
    def prevent_option_sensitive_leakage(cls, values: List[str]) -> List[str]:
        for value in values:
            if re.search(
                r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", value
            ) or re.search(
                r"\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,})", value
            ) or any(_luhn_valid(candidate) for candidate in re.findall(r"\b(?:\d[ -]*?){13,19}\b", value)):
                raise ValueError("Suspicious unredacted value detected in select options")
        return values


class Viewport(BaseModel):
    model_config = ConfigDict(extra="ignore")

    width: int = Field(..., gt=0)
    height: int = Field(..., gt=0)


class PageContext(BaseModel):
    model_config = ConfigDict(extra="ignore")

    url: str
    title: str = ""
    viewport: Viewport

    @field_validator("url", "title")
    @classmethod
    def prevent_page_sensitive_leakage(cls, value: str) -> str:
        if re.search(
            r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", value
        ):
            raise ValueError("Suspicious unredacted email detected by server")
        if re.search(
            r"\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,})", value
        ):
            raise ValueError("Suspicious unredacted authentication token detected by server")
        return value


class SanitizedContext(BaseModel):
    """Request body produced by the extension after local redaction.

    ``screenshot`` and ``screenshotData`` are accepted as compatibility
    aliases for older clients, while the canonical wire field remains
    ``image``.
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    goal: str = Field(default="", max_length=20000)
    page: PageContext
    dom: List[DOMNode] = Field(
        ..., max_length=5000, description="Max 5000 DOM nodes"
    )
    image: str = Field(
        ...,
        max_length=10000000,
        description="Base64 redacted image, max ~10MB",
        validation_alias=AliasChoices("image", "screenshot", "screenshotData"),
    )

    @field_validator("goal")
    @classmethod
    def prevent_goal_sensitive_leakage(cls, value: str) -> str:
        if re.search(
            r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", value
        ) or re.search(
            r"\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,})", value
        ):
            raise ValueError("Suspicious unredacted value detected in goal")
        return value


# Per-action argument allowlist.  This is the single source of truth used by
# both the Action validator below and the provider-side sanitizer, so a model
# that fills every schema key on every action is filtered rather than rejected.
ACTION_ARGS: Dict[str, Set[str]] = {
    "click": set(),
    "focus": set(),
    "select": {"value", "text"},
    "scroll": {"x", "y"},
    "wait": {"ms", "reason"},
    "keypress": {"key"},
    "type_local": {"secret_ref", "text", "value"},
    "done": {"reason"},
}


class Action(BaseModel):
    """A single safe browser action returned to the extension."""

    model_config = ConfigDict(extra="forbid")

    type: str = Field(
        ...,
        pattern="^(click|scroll|focus|select|wait|keypress|type_local|done)$",
    )
    target: str = Field(default="", max_length=2048)
    args: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("target")
    @classmethod
    def reject_script_target(cls, value: str) -> str:
        if re.search(r"javascript\s*:|<\s*script|\beval\s*\(", value, re.I):
            raise ValueError("Script-like action targets are not allowed")
        if value and re.search(r"[.#\[\](){}>+~,:/\\]", value) and not re.fullmatch(
            r"#?[A-Za-z0-9_-]+", value
        ) and value.lower() not in {"body", "html", "window", "document"}:
            raise ValueError("Only element IDs are allowed as action targets")
        return value

    @field_validator("args")
    @classmethod
    def args_must_be_object(cls, value: Dict[str, Any], info: ValidationInfo) -> Dict[str, Any]:
        # Pydantic has already enforced the object type.  Keep this explicit so
        # a future schema change cannot accidentally permit executable payloads.
        action_type = str(info.data.get("type") or "")
        for key, item in value.items():
            if key.lower() in {"__proto__", "prototype", "constructor"}:
                raise ValueError("Executable action argument key is not allowed")
            if key.lower() in {"code", "script", "javascript", "expression"}:
                raise ValueError("Executable action arguments are not allowed")
            if key.lower() == "secret_ref":
                if not isinstance(item, str) or not re.fullmatch(
                    r"\[?(?:email|phone|username|password)(?:_\d+)?\]?", item, re.I
                ):
                    raise ValueError("secret_ref must contain a local reference name")
            if item is not None and not isinstance(item, (str, int, float, bool)):
                raise ValueError("Unsupported action argument value")
            if isinstance(item, (int, float)) and not math.isfinite(float(item)):
                raise ValueError("Action argument number must be finite")
            if isinstance(item, str) and re.search(
                r"javascript\s*:|<\s*script|\beval\s*\(", item, re.I
            ):
                raise ValueError("Script-like action arguments are not allowed")

        allowed = ACTION_ARGS.get(action_type, set())
        if any(key not in allowed for key in value):
            raise ValueError("Action arguments do not match the action type")
        if action_type == "keypress":
            if value.get("key") not in SAFE_KEYS:
                raise ValueError("Only allowlisted navigation keys may be pressed")
        elif action_type == "wait" and "ms" in value:
            if not isinstance(value["ms"], (int, float)) or not 50 <= value["ms"] <= 5000:
                raise ValueError("Wait duration is outside the safe range")
        elif action_type == "scroll":
            for key in ("x", "y"):
                if key in value and (not isinstance(value[key], (int, float)) or abs(value[key]) > 10000):
                    raise ValueError("Scroll amount is outside the safe range")
        elif action_type == "select" and not ({"value", "text"} & set(value)):
            raise ValueError("select requires value or text")
        elif action_type == "type_local":
            if "secret_ref" in value and len(value) != 1:
                raise ValueError("secret_ref cannot be combined with plaintext")
            if "secret_ref" not in value:
                plaintext = value.get("text", value.get("value"))
                if not isinstance(plaintext, str) or len(plaintext) > 2000:
                    raise ValueError("type_local requires bounded text or a secret_ref")
        return value

    @model_validator(mode="after")
    def validate_target_scope(self):
        if self.type != "scroll" and self.target.lower() in {"body", "html", "window", "document"}:
            raise ValueError("Page-level targets are only valid for scroll")
        return self


class PlanResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    actions: List[Action] = Field(default_factory=list, max_length=MAX_ACTION_PLAN_LENGTH)
    # A provider failure must be distinguishable from a legitimate "wait"
    # instruction.  Returning an error as a bare ``wait`` action made the
    # extension treat an unavailable model as a real plan, so it executed a
    # non-meaningful wait every cycle until the budget expired.
    providerError: bool = False
    providerErrorReason: str = Field(default="", max_length=200)

    @model_validator(mode="after")
    def validate_terminal_marker(self):
        done_indexes = [index for index, action in enumerate(self.actions) if action.type == "done"]
        if len(done_indexes) > 1 or (done_indexes and done_indexes[0] != len(self.actions) - 1):
            raise ValueError("done must be the only terminal action and must be last")
        return self
