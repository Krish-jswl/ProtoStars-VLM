import logging
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from app.schemas import SanitizedContext, PlanResponse
from app.config import settings
from app.providers.mock_vlm import MockVLMProvider

app = FastAPI(title="Privacy Vision Backend")

logger = logging.getLogger("backend")
logger.setLevel(logging.INFO)

# Setup provider
if settings.vlm_provider == "mock":
    provider = MockVLMProvider()
elif settings.vlm_provider == "openai":
    from app.providers.openai_vlm import OpenAIVLMProvider
    provider = OpenAIVLMProvider()
elif settings.vlm_provider == "groq":
    from app.providers.openai_vlm import OpenAIVLMProvider
    provider = OpenAIVLMProvider(
        api_key=settings.groq_api_key or settings.openai_api_key,
        base_url="https://api.groq.com/openai/v1",
        model=settings.groq_model
    )
elif settings.vlm_provider == "gemini":
    from app.providers.openai_vlm import OpenAIVLMProvider
    provider = OpenAIVLMProvider(
        api_key=settings.gemini_api_key,
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        model=settings.gemini_model
    )
elif settings.vlm_provider == "ollama":
    from app.providers.openai_vlm import OpenAIVLMProvider
    provider = OpenAIVLMProvider(
        api_key="ollama",
        base_url=settings.vlm_base_url or "http://host.docker.internal:11434/v1",
        model=settings.vlm_model or "llama3.2-vision"
    )
elif settings.vlm_provider == "custom":
    from app.providers.openai_vlm import OpenAIVLMProvider
    provider = OpenAIVLMProvider(
        api_key=settings.openai_api_key,
        base_url=settings.vlm_base_url,
        model=settings.vlm_model
    )
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
        dom_count = len(context.dom)
        visible_count = sum(1 for n in context.dom if n.visible)
        has_passwords = any(n.inputType == 'password' for n in context.dom)
        img_len = len(context.image) if context.image else 0
        logger.info(
            f"[PLAN] goal='{context.goal or '(none)'}' "
            f"dom_nodes={dom_count} visible={visible_count} "
            f"has_password_field={has_passwords} "
            f"image_bytes={img_len} "
            f"url={context.page.url[:80]}"
        )
        plan = await provider.analyze(context)
        logger.info(f"[PLAN] => actions={[a.type + ':' + a.target for a in plan.actions]}")
        return plan
    except Exception as e:
        logger.error(f"Error during analysis: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")
