"""Unit tests for QueryService config."""

import pytest
from pydantic import ValidationError

from server.config import Settings, get_settings


def test_get_settings_returns_settings() -> None:
    """get_settings returns a Settings instance."""
    s = get_settings()
    assert isinstance(s, Settings)
    assert s.host == "0.0.0.0"
    assert s.port == 8000
    assert s.log_level == "INFO"


def test_get_settings_cached() -> None:
    """get_settings is cached (same instance)."""
    assert get_settings() is get_settings()


def test_settings_defaults() -> None:
    """Settings have expected defaults for optional fields."""
    s = get_settings()
    assert hasattr(s, "datasets_config_path")
    assert hasattr(s, "s3_bucket")
    assert hasattr(s, "s3_region")
    assert s.cors_origins == []
    assert s.seed_sample_data is False
    assert s.duckdb_memory_limit is None
    assert s.duckdb_temp_directory == "/tmp/huey-duckdb-tmp"
    assert s.duckdb_enable_object_cache is True


def test_duckdb_threads_validation() -> None:
    with pytest.raises(ValidationError):
        Settings(duckdb_threads=0)


def test_duckdb_optional_strings_normalized() -> None:
    s = Settings(duckdb_memory_limit="  ", duckdb_temp_directory=" ")
    assert s.duckdb_memory_limit is None
    assert s.duckdb_temp_directory is None


def test_cors_origins_parse_csv() -> None:
    s = Settings(cors_origins="http://localhost:8765, http://127.0.0.1:8080")
    assert s.cors_origins == ["http://localhost:8765", "http://127.0.0.1:8080"]


def test_cors_origins_parse_json_array() -> None:
    s = Settings(cors_origins='["https://app.example.com","https://admin.example.com"]')
    assert s.cors_origins == ["https://app.example.com", "https://admin.example.com"]
