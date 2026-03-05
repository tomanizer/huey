"""
QueryService configuration loader.

Loads settings from environment variables and optional config file.
"""

import json
from functools import lru_cache
from typing import Literal

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
    cors_origins: list[str] = Field(default_factory=list)

    # Optional: path to datasets config YAML (for dataset/schema loader)
    datasets_config_path: str | None = None

    # Sample data seeding (disable in production)
    seed_sample_data: bool = False

    # DuckDB
    data_dir: str | None = None  # Path to DuckDB database file; None = in-memory
    duckdb_threads: int | None = Field(default=None, ge=1, le=128)
    duckdb_memory_limit: str | None = None
    duckdb_temp_directory: str | None = "/tmp/huey-duckdb-tmp"
    duckdb_enable_object_cache: bool = True

    # Export
    # NOTE: /data/exports must be a persistent volume in production.
    # In containers, /tmp is ephemeral — pending exports are lost on restart.
    # Override via QUERYSERVICE_EXPORT_OUTPUT_DIR / QUERYSERVICE_EXPORT_DB_PATH.
    export_ttl_seconds: int = 3600
    export_max_concurrent: int = 5
    export_output_dir: str = "/data/exports"
    export_db_path: str = "/data/exports/jobs.db"

    # Query budgets
    query_timeout_seconds: float = 30.0
    max_concurrent_queries: int = 8
    max_query_queue_depth: int | None = 32
    shutdown_drain_seconds: float = 10.0  # Max wait for in-flight queries on shutdown

    # Endpoint defaults
    tuples_default_limit: int = 200
    picklist_default_limit: int = 100
    # Authentication
    api_keys: str | None = None  # Comma-separated list of valid API keys
    auth_enabled: bool = False  # Set to True to require auth

    # Dataset metadata cache
    schema_cache_ttl_seconds: float | None = 300  # Set to 0 or None to disable TTL-based refresh

    # Cells/query limits
    max_cells_per_response: int = 10000
    max_axis_cardinality: int = 5000

    # Optional: S3 / engine config (for later issues)
    s3_bucket: str | None = None
    s3_region: str | None = None

    # Rate limiting
    rate_limit_query: str = "100/minute"
    rate_limit_export: str = "10/minute"
    rate_limit_enabled: bool = False
    # Query result cache
    cache_enabled: bool = False
    cache_ttl_seconds: int = 120
    cache_max_bytes: int = 64 * 1024 * 1024
    cache_max_item_bytes: int = 1 * 1024 * 1024
    cache_admission_min_duration_ms: float = 0.0
    cache_sqlite_path: str | None = None
    cache_sqlite_max_bytes: int = 256 * 1024 * 1024
    # Dimension dictionary cache (picklist / filter values)
    dim_cache_ttl_seconds: int = 3600  # Long TTL; dimension data changes infrequently
    dim_stale_ttl_seconds: int = 0  # Extra seconds to serve stale while refreshing (0 = disabled)
    dim_version_token: str | None = None  # External override; change to force invalidation
    dim_prewarm_fields: str | None = None  # CSV of "dataset_id:field" pairs to prewarm on startup
    # Query execution
    execution_mode: Literal["sample_table", "parquet_partitioned"] = "sample_table"
    partition_base_path: str | None = None

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

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _parse_cors_origins(cls, v: object) -> list[str]:
        """Accept CSV or JSON-array input for CORS origins."""
        if v is None:
            return []
        if isinstance(v, list):
            return [str(item).strip() for item in v if str(item).strip()]
        if isinstance(v, str):
            raw = v.strip()
            if raw == "":
                return []
            if raw.startswith("["):
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError as exc:
                    raise ValueError("Invalid JSON for cors_origins") from exc
                if not isinstance(parsed, list):
                    raise ValueError("cors_origins JSON must be an array")
                return [str(item).strip() for item in parsed if str(item).strip()]
            return [item.strip() for item in raw.split(",") if item.strip()]
        raise ValueError("cors_origins must be a list or comma-separated string")


@lru_cache
def get_settings() -> Settings:
    """Return cached settings instance."""
    return Settings()
