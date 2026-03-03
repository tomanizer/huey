import pytest
from fastapi.testclient import TestClient

from server.config import get_settings
from server.main import app
from server.rate_limit import limiter


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


def _export_body() -> dict:
    return {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "export_type": "pivot_results",
            "axes": {
                "rows": [{"field": "symbol"}],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "v"}],
            },
            "filters": [],
            "max_rows": 10,
            "format": "csv",
        },
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


def test_export_rate_limit_exceeded(rate_limited_client: TestClient) -> None:
    """POST /export is rate-limited; exceeding the limit returns 429."""
    # RATE_LIMIT_EXPORT = "1/minute", so two requests should exceed it
    rate_limited_client.post("/export", json=_export_body())

    response = rate_limited_client.post("/export", json=_export_body())
    assert response.status_code == 429


def test_export_rate_limit_returns_retry_after(rate_limited_client: TestClient) -> None:
    """Exceeded export rate limit includes a Retry-After header."""
    rate_limited_client.post("/export", json=_export_body())
    response = rate_limited_client.post("/export", json=_export_body())
    assert response.status_code == 429
    retry_after = response.headers.get("Retry-After")
    assert retry_after is not None
    assert retry_after.isdigit()


def test_rate_limiting_disabled(monkeypatch) -> None:
    """When rate_limit_enabled=false, neither query nor export endpoints are throttled."""
    monkeypatch.setenv("QUERYSERVICE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("QUERYSERVICE_RATE_LIMIT_QUERY", "1/minute")
    monkeypatch.setenv("QUERYSERVICE_RATE_LIMIT_EXPORT", "1/minute")
    get_settings.cache_clear()
    limiter.enabled = False
    try:
        client = TestClient(app)
        # Query: two calls exceed the "1/minute" limit but limiting is off
        for _ in range(2):
            r = client.post("/query/tuples", json=_query_body())
            assert r.status_code == 200
        # Export: two calls exceed the "1/minute" limit but limiting is off
        for _ in range(2):
            r = client.post("/export", json=_export_body())
            assert r.status_code == 200
    finally:
        get_settings.cache_clear()
        limiter.enabled = get_settings().rate_limit_enabled
