
import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    vlm_provider: str = os.getenv("VLM_PROVIDER", "mock")
    max_payload_size_mb: int = 10

settings = Settings()
