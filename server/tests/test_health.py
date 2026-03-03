"""Tests for QueryService health endpoints."""

from fastapi.testclient import TestClient


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
