import os
from pydantic_settings import BaseSettings
from pydantic import field_validator

def get_default_provider() -> str:
    if os.getenv("VLM_PROVIDER"):
        return os.getenv("VLM_PROVIDER")
    if os.getenv("GROQ_API_KEY"):
        return "groq"
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    return "mock"

class Settings(BaseSettings):
    vlm_provider: str = get_default_provider()
    max_payload_size_mb: int = 10
    
    # OpenAI settings
    openai_api_key: str = ""
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    
    # Groq settings — use a vision-capable model
    groq_api_key: str = ""
    groq_model: str = os.getenv("GROQ_MODEL", "llama-3.2-90b-vision-preview")
    
    # Gemini settings
    gemini_api_key: str = ""
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")
    
    # Generic / Custom OpenAI-compatible settings
    vlm_base_url: str = os.getenv("VLM_BASE_URL", "")
    vlm_model: str = os.getenv("VLM_MODEL", "")

    real_vlm_enabled: bool = os.getenv("REAL_VLM_ENABLED", "false").lower() == "true"
    vlm_timeout_seconds: int = 45

    @field_validator("groq_api_key", "openai_api_key", "gemini_api_key", "vlm_base_url", mode="before")
    @classmethod
    def sanitize_env_str(cls, v: str) -> str:
        if isinstance(v, str):
            return v.strip("\"' \t\n")
        return v

settings = Settings()
