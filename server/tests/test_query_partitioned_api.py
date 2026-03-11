"""API-level tests for partition-mode errors: PartitionConfigError and PartitionNotFoundError.

These tests exercise the partition execution path at the HTTP boundary to ensure
domain errors are correctly mapped to the expected HTTP status codes and error codes.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import datasets
from server.config import get_settings
from server.query_budget import reset_query_budget


@pytest.fixture(autouse=True)
def reset_state_after_test(monkeypatch) -> None:
    """Restore environment between tests."""
    yield
    get_settings.cache_clear()
    reset_query_budget()
    datasets.reset_cache()


@pytest.fixture()
def partitioned_no_storage(monkeypatch) -> None:
    """Set execution_mode=parquet_partitioned with no bucket or base path configured."""
    monkeypatch.setenv("QUERYSERVICE_EXECUTION_MODE", "parquet_partitioned")
    monkeypatch.setenv("QUERYSERVICE_S3_BUCKET", "")
    monkeypatch.setenv("QUERYSERVICE_PARTITION_BASE_PATH", "")
    get_settings.cache_clear()
    datasets.reset_cache()


@pytest.fixture()
def partitioned_empty_base_path(monkeypatch, tmp_path: Path) -> None:
    """Set execution_mode=parquet_partitioned with an empty base path (no parquet files)."""
    monkeypatch.setenv("QUERYSERVICE_EXECUTION_MODE", "parquet_partitioned")
    monkeypatch.setenv("QUERYSERVICE_PARTITION_BASE_PATH", str(tmp_path))
    monkeypatch.setenv("QUERYSERVICE_S3_BUCKET", "")
    get_settings.cache_clear()
    datasets.reset_cache()


def _cells_body() -> dict:
    return {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
        },
    }


def _tuples_body() -> dict:
    return {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "fields": [{"field": "symbol"}],
        "paging": {"limit": 10, "offset": 0},
    }


def _picklist_body() -> dict:
    return {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "field": "symbol",
        "paging": {"limit": 10, "offset": 0},
    }


def test_partitioned_env_override_beats_dotenv(monkeypatch, tmp_path: Path) -> None:
    """Explicit env vars win over .env values for partitioned config in tests."""
    (tmp_path / ".env").write_text(
        "\n".join(
            [
                "QUERYSERVICE_EXECUTION_MODE=parquet_partitioned",
                "QUERYSERVICE_S3_BUCKET=dotenv-bucket",
                "QUERYSERVICE_PARTITION_BASE_PATH=/dotenv/path",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("QUERYSERVICE_EXECUTION_MODE", "parquet_partitioned")
    monkeypatch.setenv("QUERYSERVICE_S3_BUCKET", "")
    monkeypatch.setenv("QUERYSERVICE_PARTITION_BASE_PATH", "")
    get_settings.cache_clear()

    settings = get_settings()
    assert settings.s3_bucket == ""
    assert settings.partition_base_path == ""


def test_partition_config_error_cells_no_bucket_or_path(
    partitioned_no_storage, client: TestClient
) -> None:
    """When execution_mode=parquet_partitioned but no bucket/path is set,
    the v1 cells endpoint returns 500 PARTITION_CONFIG_ERROR."""
    body = _cells_body()
    r = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    assert r.status_code == 500
    data = r.json()
    assert data["code"] == "PARTITION_CONFIG_ERROR"


def test_partition_config_error_tuples_no_bucket_or_path(
    partitioned_no_storage, client: TestClient
) -> None:
    """Same PARTITION_CONFIG_ERROR check for the v1 tuples endpoint."""
    body = _tuples_body()
    r = client.post("/api/v1/datasets/trades_v1/query/tuples", json=body)
    assert r.status_code == 500
    data = r.json()
    assert data["code"] == "PARTITION_CONFIG_ERROR"


def test_partition_config_error_picklist_no_bucket_or_path(
    partitioned_no_storage, client: TestClient
) -> None:
    """Same PARTITION_CONFIG_ERROR check for the v1 members endpoint."""
    body = _picklist_body()
    r = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    assert r.status_code == 500
    data = r.json()
    assert data["code"] == "PARTITION_CONFIG_ERROR"


def test_partition_not_found_cells_missing_date(
    partitioned_empty_base_path, client: TestClient
) -> None:
    """When execution_mode=parquet_partitioned with a base path but the
    requested date partition directory does not exist, the v1 cells endpoint returns
    404 PARTITION_NOT_FOUND."""
    body = _cells_body()
    r = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    assert r.status_code == 404
    data = r.json()
    assert data["code"] == "PARTITION_NOT_FOUND"
    assert data["details"]["dataset_id"] == "trades_v1"
    assert "2026-03-01" in data["details"]["dates"]


def test_partition_not_found_tuples_missing_date(
    partitioned_empty_base_path, client: TestClient
) -> None:
    """Same PARTITION_NOT_FOUND check for the v1 tuples endpoint."""
    body = _tuples_body()
    r = client.post("/api/v1/datasets/trades_v1/query/tuples", json=body)
    assert r.status_code == 404
    data = r.json()
    assert data["code"] == "PARTITION_NOT_FOUND"


def test_partition_not_found_picklist_missing_date(
    partitioned_empty_base_path, client: TestClient
) -> None:
    """Same PARTITION_NOT_FOUND check for the v1 members endpoint."""
    body = _picklist_body()
    r = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    assert r.status_code == 404
    data = r.json()
    assert data["code"] == "PARTITION_NOT_FOUND"
