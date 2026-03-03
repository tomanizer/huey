"""
QueryService configuration loader.

Loads settings from environment variables and optional config file.
"""

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings with env override."""

    model_config = SettingsConfigDict(
        env_prefix="QUERYSERVICE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "INFO"
    log_format: str = "text"  # "text" for dev, "json" for production

    # Optional: path to datasets config YAML (for dataset/schema loader)
    datasets_config_path: str | None = None

    # Sample data seeding (disable in production)
    seed_sample_data: bool = True

    # DuckDB
    data_dir: str | None = None  # Path to DuckDB database file; None = in-memory
    duckdb_threads: int | None = Field(default=None, ge=1, le=128)
    duckdb_memory_limit: str | None = None
    duckdb_temp_directory: str | None = "/tmp/huey-duckdb-tmp"
    duckdb_enable_object_cache: bool = True

    # Export
    export_ttl_seconds: int = 3600
    export_max_concurrent: int = 5
    export_output_dir: str = "/tmp/huey-exports"
    export_db_path: str = "/tmp/huey-exports/jobs.db"

    # Authentication
    api_keys: str | None = None  # Comma-separated list of valid API keys
    auth_enabled: bool = False  # Set to True to require auth

    # Dataset metadata cache
    schema_cache_ttl_seconds: float | None = 300  # Set to 0 or None to disable TTL-based refresh

    # Optional: S3 / engine config (for later issues)
    s3_bucket: str | None = None
    s3_region: str | None = None

    @property
    def api_key_list(self) -> list[str]:
        if not self.api_keys:
            return []
        return [k.strip() for k in self.api_keys.split(",") if k.strip()]
      
    @field_validator("duckdb_memory_limit", "duckdb_temp_directory")
    @classmethod
    def _empty_string_to_none_or_value(cls, v: str | None) -> str | None:
        """Normalize optional string settings and reject blank values."""
        if v is None:
            return None
        value = v.strip()
        if value == "":
            return None
        return value


@lru_cache
def get_settings() -> Settings:
    """Return cached settings instance."""
    return Settings()
