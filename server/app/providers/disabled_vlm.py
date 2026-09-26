"""Safe provider used when no external planner is configured."""

from app.providers.base import VLMProvider
from app.schemas import PlanResponse, SanitizedContext


class DisabledVLMProvider(VLMProvider):
    """Report a provider error without pretending to plan an action.

    Returning a bare ``wait`` action here was indistinguishable from a real
    instruction to wait, so the extension burned its whole action budget doing
    nothing.  An explicit provider error is fail-closed and honest.
    """

    async def analyze(self, context: SanitizedContext) -> PlanResponse:
        return PlanResponse(
            actions=[],
            providerError=True,
            providerErrorReason="VLM provider disabled",
        )
