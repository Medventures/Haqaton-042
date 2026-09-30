from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MEDHUB_", env_file=Path(__file__).resolve().parents[2] / '.env', env_file_encoding="utf-8", extra="ignore"
    )

    data_dir: Path = Path("data")
    demo_enabled: bool = False
    whisperx_base_url: str = ""
    whisperx_api_token: str = ""
    whisperx_protocol: Literal["worker", "jobs"] = "worker"
    whisperx_vocabulary: str = ""
    speech_cache_enabled: bool = False
    demo_library_enabled: bool = False
    persist_workspaces: bool = True
    speech_cache_version: str = "large-v3-pyannote-v1"
    database_url: str = Field(default='', repr=False)
    workspace_ttl_seconds: int = 3600
    mis_base_url: str = ""
    mis_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="MIS_API_KEY")
    mis_timeout_seconds: float = Field(default=10, gt=0, le=60)
    max_audio_bytes: int = 30 * 1024 * 1024
    openai_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="OPENAI_API_KEY")
    openai_model: str = Field(default="gpt-4.1-mini", validation_alias="OPENAI_MODEL")
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
