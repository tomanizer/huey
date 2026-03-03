"""Tests for POST /export, GET /export/{id}, and GET /export/{id}/download."""

import time

import pytest
from fastapi.testclient import TestClient

from server.routers import export as export_module


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


def test_post_export_returns_pending(client: TestClient) -> None:
    r = client.post("/export", json=_valid_body())
    assert r.status_code == 200
    data = r.json()
    assert data["export_id"].startswith("exp-")
    assert data["status"] == "pending"


def test_export_lifecycle(client: TestClient) -> None:
    post_r = client.post("/export", json=_valid_body())
    export_id = post_r.json()["export_id"]

    r = client.get(f"/export/{export_id}")
    assert r.status_code == 200
    assert r.json()["export_id"] == export_id
    assert r.json()["status"] in ("pending", "processing", "complete")
    if r.json()["status"] == "complete":
        assert r.json()["download_url"] == f"/export/{export_id}/download"


def test_get_export_not_found(client: TestClient) -> None:
    r = client.get("/export/exp-nonexistent")
    assert r.status_code == 404


def test_post_export_dataset_not_found(client: TestClient) -> None:
    r = client.post("/export", json=_valid_body(dataset_id="nonexistent"))
    assert r.status_code == 404


def test_download_not_found(client: TestClient) -> None:
    r = client.get("/export/exp-nonexistent/download")
    assert r.status_code == 404


def test_download_not_ready(client: TestClient) -> None:
    export_module._exports["exp-test"] = {"status": "processing", "created_at": time.time()}
    r = client.get("/export/exp-test/download")
    assert r.status_code == 409


def test_download_for_failed_export(client: TestClient) -> None:
    export_module._exports["exp-fail"] = {"status": "failed", "created_at": time.time()}
    r = client.get("/export/exp-fail/download")
    assert r.status_code == 409


def test_download_file_missing_on_disk(client: TestClient) -> None:
    export_module._exports["exp-gone"] = {
        "status": "complete",
        "created_at": time.time(),
        "file_path": "/tmp/nonexistent-file.csv",
        "download_url": "/export/exp-gone/download",
    }
    r = client.get("/export/exp-gone/download")
    assert r.status_code == 404


def test_max_concurrent_limit(client: TestClient) -> None:
    for i in range(5):
        export_module._exports[f"exp-active-{i}"] = {"status": "processing", "created_at": time.time()}
    r = client.post("/export", json=_valid_body())
    assert r.status_code == 429
    assert "concurrent" in r.json()["detail"].lower()


def test_ttl_cleanup(client: TestClient, tmp_path) -> None:
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


def test_ttl_preserves_active_exports(client: TestClient) -> None:
    export_module._exports["exp-recent"] = {"status": "complete", "created_at": time.time()}
    r = client.post("/export", json=_valid_body())
    assert r.status_code == 200
    assert "exp-recent" in export_module._exports


def test_multiple_exports_unique_ids(client: TestClient) -> None:
    r1 = client.post("/export", json=_valid_body())
    r2 = client.post("/export", json=_valid_body())
    assert r1.json()["export_id"] != r2.json()["export_id"]
