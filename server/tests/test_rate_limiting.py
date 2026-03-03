import pytest
from fastapi.testclient import TestClient

from server.config import get_settings
from server.main import app, limiter


@pytest.fixture
def rate_limited_client(monkeypatch) -> TestClient:
    monkeypatch.setenv("QUERYSERVICE_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("QUERYSERVICE_RATE_LIMIT_QUERY", "2/minute")
    monkeypatch.setenv("QUERYSERVICE_RATE_LIMIT_EXPORT", "1/minute")
    get_settings.cache_clear()
    limiter.enabled = get_settings().rate_limit_enabled

    client = TestClient(app)
    yield client

    get_settings.cache_clear()
    limiter.enabled = get_settings().rate_limit_enabled


def _query_body() -> dict:
    return {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-01-01"},
        "query": {},
    }


def test_rate_limit_exceeded(rate_limited_client: TestClient) -> None:
    body = _query_body()
    for _ in range(2):
        rate_limited_client.post("/query/tuples", json=body)

    response = rate_limited_client.post("/query/tuples", json=body)
    assert response.status_code == 429


def test_rate_limit_returns_retry_after(rate_limited_client: TestClient) -> None:
    body = _query_body()
    rate_limited_client.post("/query/tuples", json=body)
    rate_limited_client.post("/query/tuples", json=body)

    response = rate_limited_client.post("/query/tuples", json=body)
    assert response.status_code == 429
    retry_after = response.headers.get("Retry-After")
    assert retry_after is not None
    assert retry_after.isdigit()
