"""Tests for GET /api/v1/datasets/{dataset_id}/schema."""

from fastapi.testclient import TestClient


def test_schema_found(client: TestClient) -> None:
    """GET /api/v1/datasets/trades_v1/schema returns 200 and schema."""
    r = client.get("/api/v1/datasets/trades_v1/schema")
    assert r.status_code == 200
    data = r.json()
    assert data["dataset_id"] == "trades_v1"
    assert "version" in data
    assert "fields" in data
    assert any(f["name"] == "symbol" for f in data["fields"])
    assert any(f["role"] == "dimension" for f in data["fields"] if f["name"] == "symbol")


def test_schema_not_found(client: TestClient) -> None:
    """GET /api/v1/datasets/nonexistent/schema returns 404."""
    r = client.get("/api/v1/datasets/nonexistent/schema")
    assert r.status_code == 404
