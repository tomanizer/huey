import hashlib

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from server.config import get_settings
from server.main import app
from server.rate_limit import get_rate_limit_key, get_real_ip, limiter


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
        rate_limited_client.post(f"/api/v1/datasets/{body['dataset_id']}/query/tuples", json=body)

    response = rate_limited_client.post(f"/api/v1/datasets/{body['dataset_id']}/query/tuples", json=body)
    assert response.status_code == 429


def test_rate_limit_returns_retry_after(rate_limited_client: TestClient) -> None:
    body = _query_body()
    rate_limited_client.post(f"/api/v1/datasets/{body['dataset_id']}/query/tuples", json=body)
    rate_limited_client.post(f"/api/v1/datasets/{body['dataset_id']}/query/tuples", json=body)

    response = rate_limited_client.post(f"/api/v1/datasets/{body['dataset_id']}/query/tuples", json=body)
    assert response.status_code == 429
    retry_after = response.headers.get("Retry-After")
    assert retry_after is not None
    assert retry_after.isdigit()


def test_export_rate_limit_exceeded(rate_limited_client: TestClient) -> None:
    """POST /exports is rate-limited; exceeding the limit returns 429."""
    # RATE_LIMIT_EXPORT = "1/minute", so two requests should exceed it
    rate_limited_client.post("/api/v1/exports", json=_export_body())

    response = rate_limited_client.post("/api/v1/exports", json=_export_body())
    assert response.status_code == 429


def test_export_rate_limit_returns_retry_after(rate_limited_client: TestClient) -> None:
    """Exceeded export rate limit includes a Retry-After header."""
    rate_limited_client.post("/api/v1/exports", json=_export_body())
    response = rate_limited_client.post("/api/v1/exports", json=_export_body())
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
            body = _query_body()
            r = client.post(f"/api/v1/datasets/{body['dataset_id']}/query/tuples", json=body)
            assert r.status_code == 200
        # Export: two calls exceed the "1/minute" limit but limiting is off
        for _ in range(2):
            r = client.post("/api/v1/exports", json=_export_body())
            assert r.status_code == 200
    finally:
        get_settings.cache_clear()
        limiter.enabled = get_settings().rate_limit_enabled


def _create_test_request(headers: dict[str, str], client_host: str = "198.51.100.99") -> Request:
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()],
        "client": (client_host, 44321),
        "server": ("testserver", 80),
    }
    return Request(scope)


def test_rate_limit_key_prefers_api_key_when_auth_enabled(monkeypatch) -> None:
    monkeypatch.setenv("QUERYSERVICE_AUTH_ENABLED", "true")
    monkeypatch.setenv("QUERYSERVICE_RATE_LIMIT_BY_API_KEY", "true")
    monkeypatch.setenv("QUERYSERVICE_API_KEYS", "client-a,client-b")
    get_settings.cache_clear()
    try:
        request = _create_test_request({"X-API-Key": "client-a", "X-Forwarded-For": "1.2.3.4"})
        expected_digest = hashlib.sha256("client-a".encode("utf-8")).hexdigest()[:16]
        key = get_rate_limit_key(request)
        assert key == f"key:{expected_digest}"
        assert "client-a" not in key
    finally:
        get_settings.cache_clear()


def test_get_real_ip_uses_trusted_proxy_depth(monkeypatch) -> None:
    monkeypatch.setenv("QUERYSERVICE_TRUSTED_PROXY_COUNT", "1")
    get_settings.cache_clear()
    try:
        request = _create_test_request({"X-Forwarded-For": "1.1.1.1, 203.0.113.50"})
        assert get_real_ip(request) == "203.0.113.50"
    finally:
        get_settings.cache_clear()


def test_get_real_ip_ignores_forwarding_headers_when_no_trusted_proxy(monkeypatch) -> None:
    monkeypatch.setenv("QUERYSERVICE_TRUSTED_PROXY_COUNT", "0")
    get_settings.cache_clear()
    try:
        request = _create_test_request({"X-Forwarded-For": "1.1.1.1", "X-Real-IP": "2.2.2.2"})
        assert get_real_ip(request) == "198.51.100.99"
    finally:
        get_settings.cache_clear()


def test_rate_limit_key_invalid_api_key_falls_back_to_ip(monkeypatch) -> None:
    monkeypatch.setenv("QUERYSERVICE_AUTH_ENABLED", "true")
    monkeypatch.setenv("QUERYSERVICE_RATE_LIMIT_BY_API_KEY", "true")
    monkeypatch.setenv("QUERYSERVICE_API_KEYS", "client-a")
    get_settings.cache_clear()
    try:
        request = _create_test_request({"X-API-Key": "unknown-key"})
        assert get_rate_limit_key(request) == "ip:198.51.100.99"
    finally:
        get_settings.cache_clear()


def test_get_real_ip_ignores_invalid_forwarded_values(monkeypatch) -> None:
    monkeypatch.setenv("QUERYSERVICE_TRUSTED_PROXY_COUNT", "1")
    get_settings.cache_clear()
    try:
        request = _create_test_request({"X-Forwarded-For": "bad-ip, 203.0.113.50"})
        assert get_real_ip(request) == "203.0.113.50"
    finally:
        get_settings.cache_clear()
