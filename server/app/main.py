import logging
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.providers.base import VLMProvider
from app.providers.mock_vlm import MockVLMProvider
from app.providers.disabled_vlm import DisabledVLMProvider
from app.schemas import PlanResponse, SanitizedContext


app = FastAPI(title="Privacy Vision Backend")

logger = logging.getLogger("backend")
logger.setLevel(logging.INFO)

# Enable DEBUG on the vlm logger so raw VLM output and parsed plans are visible.
# Set VLM_LOG_LEVEL=INFO in production to suppress these.
import os as _os
_vlm_log_level = getattr(logging, _os.getenv("VLM_LOG_LEVEL", "DEBUG").upper(), logging.DEBUG)
logging.getLogger("vlm").setLevel(_vlm_log_level)
# Propagate to the root logger so uvicorn shows these lines.
logging.basicConfig(level=logging.DEBUG, format="%(levelname)s:%(name)s: %(message)s")

# The request originates in an MV3 service worker.  Host permissions normally
# cover this request, but allowing the explicit origins also makes local
# development and browser-based test harnesses work consistently.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Request-ID"],
)


def build_provider() -> VLMProvider:
    """Create the configured planner once at application startup."""

    provider_name = settings.vlm_provider.strip().lower()
    if provider_name == "disabled":
        return DisabledVLMProvider()

    if provider_name == "mock":
        return MockVLMProvider()

    if provider_name == "openai":
        from app.providers.openai_vlm import OpenAIVLMProvider

        return OpenAIVLMProvider(
            api_key=settings.openai_api_key,
            model=settings.openai_model,
        )

    if provider_name == "groq":
        from app.providers.openai_vlm import OpenAIVLMProvider

        return OpenAIVLMProvider(
            api_key=settings.groq_api_key or settings.openai_api_key,
            base_url="https://api.groq.com/openai/v1",
            model=settings.groq_model,
        )

    if provider_name == "gemini":
        from app.providers.openai_vlm import OpenAIVLMProvider

        return OpenAIVLMProvider(
            api_key=settings.gemini_api_key,
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            model=settings.gemini_model,
        )

    if provider_name == "ollama":
        from app.providers.openai_vlm import OpenAIVLMProvider

        return OpenAIVLMProvider(
            api_key="ollama",
            base_url=settings.vlm_base_url or "http://host.docker.internal:11434/v1",
            model=settings.vlm_model or "llama3.2-vision",
        )

    if provider_name == "custom":
        from app.providers.openai_vlm import OpenAIVLMProvider

        return OpenAIVLMProvider(
            api_key=settings.openai_api_key,
            base_url=settings.vlm_base_url,
            model=settings.vlm_model,
        )

    raise RuntimeError(f"Unknown VLM provider: {settings.vlm_provider}")


# Keep the provider as a module-level object so tests and deployments can
# replace/monkeypatch it without changing the endpoint contract.
provider = build_provider()


def _is_provider_failure(plan: PlanResponse) -> bool:
    # Providers report failures explicitly.  The legacy shape check is kept so a
    # custom provider that still returns a bare ``wait`` error marker is also
    # recognized instead of being executed as a real instruction.
    if plan.providerError:
        return True
    if len(plan.actions) != 1:
        return False
    action = plan.actions[0]
    reason = str(action.args.get("reason", "")).lower()
    return action.type == "wait" and any(
        marker in reason
        for marker in ("vlm", "provider", "quota", "timeout", "rate limit")
    )


@app.middleware("http")
async def limit_payload_size(request: Request, call_next):
    """Reject oversized requests before JSON parsing.

    ``Content-Length`` is only a fast-path check; the Pydantic model still
    bounds the image and DOM after parsing.  Invalid/missing headers must not
    turn into a server error.
    """

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            request_size = int(content_length)
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
        if request_size > settings.max_payload_size_mb * 1024 * 1024:
            return JSONResponse(status_code=413, content={"detail": "Payload too large"})

    response = await call_next(request)
    return response


def _safe_url_for_log(url: str) -> str:
    """Avoid putting query strings (which often contain PII) in logs."""

    return url.split("?", 1)[0].split("#", 1)[0][:160]


@app.post("/v1/agent/plan", response_model=PlanResponse)
async def plan_action(context: SanitizedContext):
    try:
        visible_count = sum(1 for node in context.dom if node.visible)
        has_passwords = any(node.inputType == "password" for node in context.dom)
        image_length = len(context.image)
        logger.info(
            "[PLAN] goal_present=%s dom_nodes=%d visible=%d "
            "has_password_field=%s image_chars=%d url=%s",
            bool(context.goal),
            len(context.dom),
            visible_count,
            has_passwords,
            image_length,
            _safe_url_for_log(context.page.url),
        )

        plan: Any = await provider.analyze(context)
        # Providers are typed, but this guard keeps a custom provider from
        # returning an accidental non-JSON value at the API boundary.
        if not isinstance(plan, PlanResponse):
            plan = PlanResponse.model_validate(plan)

        logger.debug(
            "[PLAN DEBUG] providerError=%s actions=%d: %s",
            plan.providerError,
            len(plan.actions),
            [{"type": a.type, "target": a.target} for a in plan.actions],
        )

        # An unavailable external VLM should not make simple, explicitly
        # requested allowlisted tasks unusable. The fallback is deliberately
        # narrow: it only runs for a recognized goal and only accepts a
        # non-empty deterministic plan; otherwise the provider error is kept.
        if (
            _is_provider_failure(plan)
            and settings.vlm_fallback_to_mock
            and settings.vlm_provider != "mock"
            and context.goal
        ):
            fallback_plan = await MockVLMProvider().analyze(context)
            only_done = (
                len(fallback_plan.actions) == 1
                and fallback_plan.actions[0].type == "done"
            )
            if not only_done:
                logger.warning("Using deterministic mock fallback after VLM failure")
                plan = fallback_plan

        logger.info("[PLAN] actions=%d", len(plan.actions))
        return plan
    except HTTPException:
        raise
    except Exception:
        # Do not include exception text in the response (or logs): provider
        # errors can contain request fragments. The extension receives a stable
        # error contract and can retry/report it safely.
        logger.error("Error during analysis")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/v1/models")
async def models():
    """Expose only the locally configured provider/model, never credentials."""

    model = getattr(provider, "model", None)
    return {
        "object": "list",
        "data": [{
            "id": str(model)[:120] if model else settings.vlm_provider,
            "object": "model",
            "owned_by": settings.vlm_provider,
        }],
    }


@app.get("/health")
async def health():
    model = getattr(provider, "model", None)
    return {
        "status": "ok",
        "provider": settings.vlm_provider,
        "model": str(model)[:120] if model else None,
    }
