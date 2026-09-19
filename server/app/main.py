
import logging
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from app.schemas import SanitizedContext, PlanResponse
from app.config import settings
from app.providers.mock_vlm import MockVLMProvider

app = FastAPI(title="Privacy Vision Backend")

# We deliberately DO NOT log request bodies to prevent accidental PII leakage if the extension fails.
# logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("backend")
logger.setLevel(logging.INFO)

# Setup provider
if settings.vlm_provider == "mock":
    provider = MockVLMProvider()
elif settings.vlm_provider == "openai":
    from app.providers.openai_vlm import OpenAIVLMProvider
    provider = OpenAIVLMProvider()
else:
    raise RuntimeError(f"Unknown provider: {settings.vlm_provider}")

@app.middleware("http")
async def limit_payload_size(request: Request, call_next):
    # Defense in depth: strictly limit payload size
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > settings.max_payload_size_mb * 1024 * 1024:
        return JSONResponse(status_code=413, content={"detail": "Payload too large"})
    response = await call_next(request)
    return response

@app.post("/v1/agent/plan", response_model=PlanResponse)
async def plan_action(context: SanitizedContext):
    try:
        # Pass to VLM Provider
        # We assume context is clean here due to Pydantic defense-in-depth and Extension Privacy Gate
        plan = await provider.analyze(context)
        return plan
    except Exception as e:
        logger.error("Error during analysis")
        raise HTTPException(status_code=500, detail="Internal server error")
