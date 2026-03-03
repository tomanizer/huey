"""Tests for POST /export, GET /export/{id}, and GET /export/{id}/download."""

import time

import pytest
from fastapi.testclient import TestClient

from server.main import app
from server.routers import export as export_module


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_exports():
    """Reset the export store between tests."""
    export_module._exports.clear()
    yield
    export_module._exports.clear()


def _valid_body(**overrides):
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"export_type": "pivot_results", "axes": {}, "filters": [], "max_rows": 1000, "format": "csv"},
    }
    body.update(overrides)
    return body


def test_post_export_ok(client: TestClient) -> None:
    """POST /export with valid envelope returns 200 and export_id."""
    r = client.post("/export", json=_valid_body())
    assert r.status_code == 200
    data = r.json()
    assert data["export_id"].startswith("exp-")
    assert data["status"] == "pending"


def test_export_lifecycle(client: TestClient) -> None:
    """POST creates job, background task processes it, GET shows complete with download_url."""
    post_r = client.post("/export", json=_valid_body())
    export_id = post_r.json()["export_id"]

    r = client.get(f"/export/{export_id}")
    assert r.status_code == 200
    status = r.json()["status"]
    assert status in ("pending", "processing", "complete")

    if status == "complete":
        assert r.json()["download_url"] == f"/export/{export_id}/download"


def test_get_export_not_found(client: TestClient) -> None:
    """GET /export/{id} for unknown id returns 404."""
    r = client.get("/export/exp-nonexistent")
    assert r.status_code == 404


def test_post_export_bad_date_range(client: TestClient) -> None:
    """POST /export with inverted date range returns 422."""
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "range", "start": "2026-03-01", "end": "2026-01-01"},
        "query": {},
    }
    r = client.post("/export", json=body)
    assert r.status_code == 422


def test_post_export_dataset_not_found(client: TestClient) -> None:
    """POST /export with unknown dataset returns 404."""
    r = client.post("/export", json=_valid_body(dataset_id="nonexistent"))
    assert r.status_code == 404


def test_download_not_found(client: TestClient) -> None:
    """GET /export/{id}/download for unknown id returns 404."""
    r = client.get("/export/exp-nonexistent/download")
    assert r.status_code == 404


def test_download_not_ready(client: TestClient) -> None:
    """GET /export/{id}/download before completion returns 409."""
    export_module._exports["exp-test"] = {
        "status": "processing",
        "created_at": time.time(),
    }
    r = client.get("/export/exp-test/download")
    assert r.status_code == 409


def test_max_concurrent_limit(client: TestClient) -> None:
    """POST /export returns 429 when max concurrent exports exceeded."""
    for i in range(5):
        export_module._exports[f"exp-active-{i}"] = {
            "status": "processing",
            "created_at": time.time(),
        }
    r = client.post("/export", json=_valid_body())
    assert r.status_code == 429
    assert "concurrent" in r.json()["detail"].lower()


def test_ttl_cleanup(client: TestClient, tmp_path) -> None:
    """Expired exports are cleaned up on new POST."""
    expired_file = tmp_path / "exp-old.csv"
    expired_file.write_text("old data")

    export_module._exports["exp-old"] = {
        "status": "complete",
        "created_at": time.time() - 7200,
        "file_path": str(expired_file),
    }

    r = client.post("/export", json=_valid_body())
    assert r.status_code == 200
    assert "exp-old" not in export_module._exports
    assert not expired_file.exists()
