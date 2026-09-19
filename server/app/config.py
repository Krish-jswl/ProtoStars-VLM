import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    vlm_provider: str = os.getenv("VLM_PROVIDER", "mock")
    max_payload_size_mb: int = 10
    
    # OpenAI settings
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    real_vlm_enabled: bool = os.getenv("REAL_VLM_ENABLED", "false").lower() == "true"
    vlm_timeout_seconds: int = 30

settings = Settings()
