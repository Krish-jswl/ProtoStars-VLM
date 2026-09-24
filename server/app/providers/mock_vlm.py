from app.providers.base import VLMProvider
from app.schemas import SanitizedContext, PlanResponse, Action

class MockVLMProvider(VLMProvider):
    async def analyze(self, context: SanitizedContext) -> PlanResponse:
        goal = (context.goal or "").lower().strip()
        
        # Default behavior when no goal provided (preserves test suite compatibility)
        if not goal:
            return PlanResponse(
                actions=[
                    Action(type="click", target="mock_element_1"),
                    Action(type="type_local", target="mock_element_2", args={"secret_ref": "PASSWORD_1"})
                ]
            )

        # Match elements mentioned in the goal
        for node in context.dom:
            node_id = (node.id or "").lower()
            node_text = (node.text or "").lower()
            if node.id and ((node_id and node_id in goal) or (node_text and node_text in goal)):
                return PlanResponse(actions=[Action(type="click", target=node.id)])

        # Interactive elements matching button/click actions
        buttons = [n for n in context.dom if n.id and (n.tag == "button" or n.role == "button") and n.visible]
        if buttons:
            return PlanResponse(actions=[Action(type="click", target=buttons[0].id)])

        # Any visible interactive element
        interactive = [n for n in context.dom if n.id and n.visible and n.enabled]
        if interactive:
            return PlanResponse(actions=[Action(type="click", target=interactive[0].id)])

        return PlanResponse(actions=[Action(type="done", target="", args={"reason": "Goal completed"})])
