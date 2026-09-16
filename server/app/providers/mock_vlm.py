
from app.providers.base import VLMProvider
from app.schemas import SanitizedContext, PlanResponse, Action

class MockVLMProvider(VLMProvider):
    async def analyze(self, context: SanitizedContext) -> PlanResponse:
        # Deterministic mock response for testing
        return PlanResponse(
            actions=[
                Action(type="click", target="mock_element_1"),
                Action(type="type_local", target="mock_element_2", args={"secret_ref": "PASSWORD_1"})
            ]
        )
