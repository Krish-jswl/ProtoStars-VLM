
from abc import ABC, abstractmethod
from app.schemas import SanitizedContext, PlanResponse

class VLMProvider(ABC):
    @abstractmethod
    async def analyze(self, context: SanitizedContext) -> PlanResponse:
        pass
