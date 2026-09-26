"""Deterministic local planner used for development and offline tests.

The mock is intentionally useful rather than returning synthetic element IDs.
That makes an offline backend exercise the same wire contract as a real VLM:
every action targets an element that is present in the supplied context and the
returned object is a normal ``{"actions": [...]}`` JSON plan.
"""

import re
from typing import Iterable, List, Optional, Sequence

from app.providers.base import VLMProvider
from app.schemas import Action, DOMNode, PlanResponse, SanitizedContext


class MockVLMProvider(VLMProvider):
    async def analyze(self, context: SanitizedContext) -> PlanResponse:
        raw_goal = (context.goal or "").strip()
        goal = raw_goal.lower()

        # Keep the original deterministic response for the no-goal smoke test.
        # It is useful for checking the transport without pretending to plan a
        # task.
        if not goal:
            return PlanResponse(
                actions=[
                    Action(type="click", target="mock_element_1"),
                    Action(
                        type="type_local",
                        target="mock_element_2",
                        args={"secret_ref": "PASSWORD_1"},
                    ),
                ]
            )

        actions = self._plan_for_goal(context, goal, raw_goal)
        return PlanResponse(actions=actions or [Action(type="done", target="")])

    # ------------------------------------------------------------------
    # Goal planning helpers
    # ------------------------------------------------------------------
    def _plan_for_goal(
        self, context: SanitizedContext, goal: str, text_goal: Optional[str] = None
    ) -> List[Action]:
        text_goal = text_goal if text_goal is not None else goal
        nodes = self._usable_nodes(context)

        note_intent = bool(re.search(r"\b(note|memo|annotation|comment|task)\b", goal))
        login_intent = bool(re.search(r"\b(log\s*in|login|sign\s*in|signin|authenticate)\b", goal))

        note_actions = self._plan_note(goal, nodes, text_goal) if note_intent else []
        login_actions = self._plan_login(goal, nodes) if login_intent else []

        # A composite "log in and add a task" request needs to preserve the
        # login step first. If login changes pages, the generation check in the
        # extension will re-observe before the task action is attempted.
        if login_intent and note_intent and login_actions:
            combined = [action for action in login_actions if action.type != "done"]
            combined.extend(action for action in note_actions if action.type != "done")
            if combined:
                # A task/note plan is terminal once its editable field and
                # submit control have been handled. Keep the login phase
                # non-terminal when the task form is not visible yet, so the
                # extension can re-observe after a navigation.
                if note_actions and any(action.type == "done" for action in note_actions):
                    combined.append(Action(type="done", target=""))
                return combined

        if note_actions:
            return note_actions
        if login_actions:
            return login_actions

        # A direct target mention is the most reliable interpretation for a
        # deterministic planner (and mirrors the real VLM contract).
        direct = self._node_mentioned_in_goal(goal, nodes)
        if direct:
            return self._with_done([self._action_for_node(direct, goal, text_goal)])

        if re.search(r"\b(scroll|down|lower)\b", goal):
            return self._with_done([Action(type="scroll", target="body", args={"y": 500, "x": 0})])

        # "type hello into the note/title field" is common even when the goal
        # does not use the word "add note".
        if re.search(r"\b(type|enter|fill|write)\b", goal):
            text = self._requested_text(text_goal)
            field = self._best_field(nodes, goal)
            if text and field:
                return self._with_done([self._type_action(field, text)])

        if re.search(r"\b(select|choose)\b", goal):
            field = self._first(nodes, lambda n: n.tag == "select")
            if field:
                text = self._requested_text(text_goal)
                if not text:
                    selected = re.search(r"\b(?:select|choose)\s+(.+)$", goal)
                    text = selected.group(1).strip() if selected else ""
                return self._with_done([Action(type="select", target=field.id, args={"text": text or ""})])

        if re.search(r"\b(click|press|tap|open|activate)\b", goal):
            button = self._best_button(nodes, goal)
            if button:
                return self._with_done([Action(type="click", target=button.id)])

        return []

    def _with_done(self, actions: Sequence[Action]) -> List[Action]:
        """Make a complete, explicitly requested single action terminal.

        Without a terminal marker the extension correctly re-observes after
        an action, but a deterministic single-step command would then be
        replayed on every cycle. Intermediate multi-step plans (for example,
        clicking Add before a form exists) deliberately do not call this
        helper.
        """

        result = list(actions)
        if result and not any(action.type == "done" for action in result):
            result.append(Action(type="done", target=""))
        return result

    def _plan_note(
        self, goal: str, nodes: Sequence[DOMNode], text_goal: Optional[str] = None
    ) -> List[Action]:
        if not re.search(r"\b(note|memo|annotation|comment|task)\b", goal):
            return []

        text_goal = text_goal if text_goal is not None else goal
        text = self._requested_note_text(text_goal) or self._requested_text(text_goal)
        # Rank all editable controls, then prefer task/title semantics and
        # Notion-style textbox/contenteditable elements over generic inputs
        # such as a page search box.
        fields = [
            node for node in nodes
            if self._is_editable(node) and not self._is_password_node(node)
        ]
        fields = [node for node in fields if not self._is_non_task_field(node)]
        fields.sort(key=self._field_score, reverse=True)

        buttons = [node for node in nodes if self._is_button(node)]
        add_button = self._best_matching_button(
            buttons, ("add", "new", "create", "note", "memo")
        )
        save_button = self._best_matching_button(
            buttons, ("save", "submit", "confirm", "done", "create")
        )

        actions: List[Action] = []
        # When no task field is visible the composer has to be opened before
        # anything can be typed.  This is driven purely by the absence of a
        # field: "Add task" is frequently both the opener and the submit
        # control, and an already-visible editor must never be re-opened by
        # clicking a global "New" control.
        if add_button and not fields:
            actions.append(Action(type="click", target=add_button.id))

        if fields and text:
            actions.append(self._type_action(fields[0], text))

            # Some task UIs use the same task-specific "Add task" control both
            # to open the form and to submit the completed value. A generic
            # global "New" button (as used by Notion) must not be clicked again
            # once the title editor is already visible.
            submit_button = save_button
            if submit_button is None and add_button and self._is_task_submit_button(add_button):
                submit_button = add_button
            if submit_button and (not actions or submit_button.id != actions[-1].target):
                actions.append(Action(type="click", target=submit_button.id))
            elif not submit_button and re.search(r"\b(?:press|hit|using|with)\s+enter\b", goal):
                actions.append(Action(type="keypress", target="", args={"key": "Enter"}))
            actions.append(Action(type="done", target=""))

        # A click-only plan (the composer was opened but no field was found) is
        # deliberately non-terminal: the extension re-observes after the click
        # and the next cycle can type once the editor has mounted.  Appending a
        # terminal ``done`` here claimed completion while nothing was created.
        if actions and (fields or add_button):
            return actions
        return []

    def _plan_login(self, goal: str, nodes: Sequence[DOMNode]) -> List[Action]:
        if not re.search(r"\b(log\s*in|login|sign\s*in|signin|authenticate)\b", goal):
            return []

        fields = [node for node in nodes if self._is_editable(node)]
        email = self._first(
            fields,
            lambda n: n.inputType.lower() == "email"
            or "email" in self._haystack(n)
            or "username" in self._haystack(n),
        )
        password = self._first(fields, lambda n: n.inputType.lower() == "password" or "password" in self._haystack(n))

        actions: List[Action] = []
        if email:
            ref = "username" if "username" in self._haystack(email) and email.inputType.lower() != "email" else "email"
            actions.append(
                Action(type="type_local", target=email.id, args={"secret_ref": ref})
            )
        if password:
            actions.append(
                Action(type="type_local", target=password.id, args={"secret_ref": "password"})
            )

        button = self._best_matching_button(
            [node for node in nodes if self._is_button(node)],
            ("login", "log in", "sign in", "signin", "submit", "continue"),
        )
        if button:
            actions.append(Action(type="click", target=button.id))
            actions.append(Action(type="done", target=""))

        if actions:
            return actions
        return []

    # ------------------------------------------------------------------
    # Element matching helpers
    # ------------------------------------------------------------------
    def _usable_nodes(self, context: SanitizedContext) -> List[DOMNode]:
        return [node for node in context.dom if node.visible and node.enabled and node.id]

    def _haystack(self, node: DOMNode) -> str:
        return " ".join(
            str(value or "")
            for value in (
                node.id,
                node.tag,
                node.role,
                node.text,
                node.inputType,
                node.autocomplete,
                node.placeholder,
                node.ariaLabel,
                node.name,
                node.label,
                " ".join(node.options or []),
            )
        ).lower()

    def _is_button(self, node: DOMNode) -> bool:
        return node.tag.lower() in {"button", "a"} or node.role.lower() in {
            "button", "link", "menuitem", "tab", "checkbox", "switch", "radio", "option", "treeitem"
        }

    def _is_editable(self, node: DOMNode) -> bool:
        return (node.tag.lower() in {"input", "textarea"} or node.inputType.lower() == "contenteditable") and not node.readOnly

    def _field_score(self, node: DOMNode) -> int:
        haystack = self._haystack(node)
        semantic_words = (
            "note", "memo", "title", "subject", "annotation", "comment",
            "body", "content", "description", "task", "todo",
        )
        score = sum(1 for word in semantic_words if word in haystack)
        if self._is_contenteditable_node(node):
            score += 3
        if node.role.lower() in {"textbox", "combobox"}:
            score += 2
        if node.tag.lower() in {"input", "textarea"}:
            score += 1
        return score

    def _is_non_task_field(self, node: DOMNode) -> bool:
        """A search/filter control is never the requested task composer.

        Typing task text into a site search box accomplishes nothing and used to
        produce a plan that looked valid but could never create a task.
        """

        haystack = self._haystack(node)
        if re.search(r"\b(?:search|filter|find)\b", haystack):
            return True
        return node.role.lower() == "searchbox"

    def _is_password_node(self, node: DOMNode) -> bool:
        identity = " ".join(
            str(value or "")
            for value in (node.id, node.name, node.ariaLabel, node.placeholder, node.label)
        ).lower()
        return (
            node.inputType.lower() == "password"
            or node.autocomplete.lower() in {"current-password", "new-password"}
            or bool(re.search(r"password|passwd|pwd", identity))
        )

    def _is_plain_text_input(self, node: DOMNode) -> bool:
        return node.tag.lower() == "input" and node.inputType.lower() in {"", "text", "search", "url"}

    def _is_contenteditable_node(self, node: DOMNode) -> bool:
        return node.inputType.lower() == "contenteditable"

    def _is_task_submit_button(self, node: DOMNode) -> bool:
        identity = " ".join(
            str(value or "")
            for value in (node.id, node.name, node.text, node.placeholder, node.ariaLabel, node.label)
        ).lower()
        return bool(
            re.search(r"\b(add|create)\b.*\b(task|todo|note|memo)\b", identity)
            or re.search(r"\b(task|todo|note|memo)\b.*\b(add|create)\b", identity)
        )

    def _contains_any(self, node: DOMNode, words: Iterable[str]) -> bool:
        haystack = self._haystack(node)
        return any(word.lower() in haystack for word in words)

    def _first(self, nodes: Iterable[DOMNode], predicate) -> Optional[DOMNode]:
        return next((node for node in nodes if predicate(node)), None)

    def _node_mentioned_in_goal(self, goal: str, nodes: Sequence[DOMNode]) -> Optional[DOMNode]:
        # Prefer an explicit ID, then a direct text/label match.
        for node in nodes:
            if node.id and re.search(rf"(?<![a-z0-9_-]){re.escape(node.id.lower())}(?![a-z0-9_-])", goal):
                return node
        for node in nodes:
            label = (node.text or node.placeholder or node.ariaLabel or "").strip().lower()
            if len(label) >= 3 and label in goal:
                return node
        return None

    def _best_button(self, nodes: Sequence[DOMNode], goal: str) -> Optional[DOMNode]:
        buttons = [node for node in nodes if self._is_button(node)]
        if not buttons:
            return None

        mentioned = self._node_mentioned_in_goal(goal, buttons)
        if mentioned:
            return mentioned

        # Score by meaningful words in the goal, avoiding generic words that
        # would make every button look like a match.
        stop_words = {"the", "a", "an", "to", "on", "in", "and", "then", "please", "click", "press", "button", "page"}
        words = [word for word in re.findall(r"[a-z0-9]+", goal) if word not in stop_words and len(word) > 2]
        scored = []
        for node in buttons:
            haystack = self._haystack(node)
            score = sum(1 for word in words if word in haystack)
            if score:
                scored.append((score, node))
        return max(scored, key=lambda item: item[0])[1] if scored else None

    def _best_matching_button(
        self, buttons: Sequence[DOMNode], words: Sequence[str]
    ) -> Optional[DOMNode]:
        scored = []
        for node in buttons:
            haystack = self._haystack(node)
            identity = f"{node.id} {node.text} {node.placeholder} {node.ariaLabel}".lower()
            score = 0
            for word in words:
                if word in haystack:
                    score += 3 if word in identity else 1
            if score:
                scored.append((score, node))
        return max(scored, key=lambda item: item[0])[1] if scored else None

    def _best_field(self, nodes: Sequence[DOMNode], goal: str) -> Optional[DOMNode]:
        fields = [node for node in nodes if self._is_editable(node)]
        if not fields:
            return None
        mentioned = self._node_mentioned_in_goal(goal, fields)
        if mentioned:
            return mentioned
        return fields[0]

    def _action_for_node(
        self, node: DOMNode, goal: str, text_goal: Optional[str] = None
    ) -> Action:
        text_goal = text_goal if text_goal is not None else goal
        if self._is_editable(node) and re.search(r"\b(type|enter|fill|write)\b", goal):
            text = self._requested_text(text_goal)
            if text:
                return self._type_action(node, text)
        if node.tag == "select":
            return Action(type="select", target=node.id, args={"text": self._requested_text(goal) or ""})
        return Action(type="click", target=node.id)

    def _type_action(self, node: DOMNode, text: str) -> Action:
        return Action(type="type_local", target=node.id, args={"text": text})

    def _requested_note_text(self, goal: str) -> Optional[str]:
        quoted = re.search(r"[\"']([^\"']{1,200})[\"']", goal)
        if quoted:
            return quoted.group(1).strip()
        named = re.search(
            r"\b(?:name(?:d)?|title|titled|called)\s+(?:the\s+)?([a-z0-9 _-]{1,100})",
            goal,
        )
        if named:
            value = named.group(1).strip(" -")
            # Do not consume the rest of a compound command.
            value = re.split(r"\s+(?:and|then|by|using|with)\s+", value, maxsplit=1)[0]
            return value.strip() or None
        after_note = re.search(
            r"\b(?:note|memo)\s+(?:named\s+)?([a-z0-9_-]{1,100})", goal
        )
        if after_note:
            value = after_note.group(1).strip("-")
            if value not in {"and", "then", "click", "save", "submit"}:
                return value
        return None

    def _requested_text(self, goal: str) -> Optional[str]:
        quoted = re.search(r"[\"']([^\"']{1,200})[\"']", goal)
        if quoted:
            return quoted.group(1).strip()
        typed = re.search(
            r"\b(?:type|enter|fill|write)\s+(?:the\s+)?(.+?)(?=\s+(?:in|into|on|to)\s+|\s+(?:field|input)\b|[,.;]|$)",
            goal,
        )
        if typed:
            return typed.group(1).strip()
        return None
