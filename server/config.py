"""
QueryService configuration loader.

Loads settings from environment variables and optional config file.
"""

from functools import lru_cache
from typing import Optional

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
    datasets_config_path: Optional[str] = None

    # Sample data seeding (disable in production)
    seed_sample_data: bool = True

    # DuckDB
    data_dir: Optional[str] = None  # Path to DuckDB database file; None = in-memory

    # Export
    export_ttl_seconds: int = 3600
    export_max_concurrent: int = 5
    export_output_dir: str = "/tmp/huey-exports"
    export_db_path: str = "/tmp/huey-exports/jobs.db"

    # Optional: S3 / engine config (for later issues)
    s3_bucket: Optional[str] = None
    s3_region: Optional[str] = None


@lru_cache
def get_settings() -> Settings:
    """Return cached settings instance."""
    return Settings()
