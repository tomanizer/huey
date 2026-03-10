"""Tests for v1 routing infrastructure and startup probe."""

from fastapi.testclient import TestClient

from server.routers import health


def test_api_v1_root(client: TestClient) -> None:
    r = client.get("/api/v1")
    assert r.status_code == 200
    data = r.json()
    assert data["service"] == "huey-queryservice"
    assert data["api_version"] == "1"
    assert "datasets" not in data["links"]
    assert data["links"]["openapi"] == "/api/v1/openapi.json"


def test_api_v1_openapi_and_docs(client: TestClient) -> None:
    openapi = client.get("/api/v1/openapi.json")
    docs = client.get("/api/v1/docs")
    redoc = client.get("/api/v1/redoc")

    assert openapi.status_code == 200
    assert docs.status_code == 200
    assert redoc.status_code == 200
    assert openapi.json()["info"]["version"] == "1.0.0"


def test_health_startup_probe(client: TestClient) -> None:
    health.reset_startup_complete()
    try:
        r_starting = client.get("/health/startup")
        assert r_starting.status_code == 503
        assert r_starting.json() == {"status": "starting"}

        health.mark_startup_complete()
        r_ready = client.get("/health/startup")
        assert r_ready.status_code == 200
        assert r_ready.json() == {"status": "ok"}
    finally:
        health.mark_startup_complete()


def test_versioned_schema_route(client: TestClient) -> None:
    r = client.get("/api/v1/datasets/trades_v1/schema")
    assert r.status_code == 200
    data = r.json()
    assert data["dataset_id"] == "trades_v1"


def test_versioned_query_route_alias(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 0}},
    }
    r = client.post("/api/v1/datasets/trades_v1/query/tuples", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["total_count"] > 0
    assert len(data["items"]) > 0
