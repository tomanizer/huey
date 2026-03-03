"""
QueryService configuration loader.

Loads settings from environment variables and optional config file.
"""

from functools import lru_cache

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

    # Export
    export_ttl_seconds: int = 3600
    export_max_concurrent: int = 5
    export_output_dir: str = "/tmp/huey-exports"
    export_db_path: str = "/tmp/huey-exports/jobs.db"

    # Dataset metadata cache
    schema_cache_ttl_seconds: float | None = 300  # Set to 0 or None to disable TTL-based refresh

    # Optional: S3 / engine config (for later issues)
    s3_bucket: str | None = None
    s3_region: str | None = None

    # Query execution
    execution_mode: str = "sample_table"  # "sample_table" | "parquet_partitioned"
    partition_base_path: str | None = None


@lru_cache
def get_settings() -> Settings:
    """Return cached settings instance."""
    return Settings()
