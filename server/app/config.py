"""Application configuration.

The backend is run from a few different working directories (repository root,
``server/``, or a container), so provider settings are read from environment
variables first and then from the repository's ``.env`` file when it exists.
No secret values are logged or returned by this module.
"""

import os
from pathlib import Path

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# config.py lives at <repo>/server/app/config.py.  Resolve the repository root
# instead of relying on the process working directory.
_REPO_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


def get_default_provider() -> str:
    """Backward-compatible environment-only provider inference helper."""

    explicit = os.getenv("VLM_PROVIDER", "").strip().lower()
    if explicit:
        return explicit
    if os.getenv("GROQ_API_KEY"):
        return "groq"
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    if os.getenv("GEMINI_API_KEY"):
        return "gemini"
    return "disabled"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_REPO_ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # An empty value means "infer from the available provider key".  This lets
    # a local .env file work without requiring a second VLM_PROVIDER setting.
    vlm_provider: str = ""
    max_payload_size_mb: int = 10

    # OpenAI settings
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"

    # Groq settings — use the currently documented vision-capable model.
    groq_api_key: str = ""
    groq_model: str = "qwen/qwen3.8-27b"

    # Gemini settings
    gemini_api_key: str = ""
    gemini_model: str = "gemini-1.5-flash"

    # Generic / custom OpenAI-compatible settings
    vlm_base_url: str = ""
    vlm_model: str = ""

    real_vlm_enabled: bool = False
    # Mock planning is an explicit development/test opt-in. Normal operation
    # must not silently replace a real provider with a server-side planner.
    vlm_fallback_to_mock: bool = False
    vlm_timeout_seconds: int = 30

    @model_validator(mode="after")
    def infer_provider(self) -> "Settings":
        if not self.vlm_provider:
            if self.groq_api_key:
                self.vlm_provider = "groq"
            elif self.openai_api_key:
                self.vlm_provider = "openai"
            elif self.gemini_api_key:
                self.vlm_provider = "gemini"
            else:
                self.vlm_provider = "disabled"
        return self

    @model_validator(mode="after")
    def normalize_provider_name(self) -> "Settings":
        self.vlm_provider = self.vlm_provider.strip().lower()
        return self

    @field_validator(
        "openai_api_key",
        "groq_api_key",
        "gemini_api_key",
        "vlm_base_url",
        mode="before",
    )
    @classmethod
    def strip_quoted_env_value(cls, value):
        if isinstance(value, str):
            return value.strip("\"' \t\n")
        return value


settings = Settings()
