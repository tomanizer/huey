"""Tests for QueryService health endpoints."""

from fastapi.testclient import TestClient

from server.routers import health


def test_liveness(client: TestClient) -> None:
    """GET /health/liveness returns 200 and status ok."""
    r = client.get("/health/liveness")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_readiness(client: TestClient) -> None:
    """GET /health/readiness returns 200 and status ok."""
    r = client.get("/health/readiness")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_readiness_unhealthy_returns_503(client: TestClient, monkeypatch) -> None:
    """GET /health/readiness returns 503 when engine health check fails."""
    monkeypatch.setattr(health.db_manager, "health_check", lambda: False)
    r = client.get("/health/readiness")
    assert r.status_code == 503
    assert r.json() == {"status": "unavailable"}
