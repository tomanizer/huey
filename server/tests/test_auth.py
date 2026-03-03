"""Tests for API key authentication across all protected endpoints."""

import pytest
from fastapi.testclient import TestClient

VALID_KEY = "test-key-123"
INVALID_KEY = "wrong-key"

# (method, path, minimal_body) for every protected endpoint
_PROTECTED_ENDPOINTS = [
    ("GET", "/schema", None, {"dataset_id": "trades_v1"}),
    ("POST", "/query/tuples", {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"axes": {"rows": [{"field": "symbol"}], "columns": [], "measures": []}},
    }, {}),
    ("POST", "/query/cells", {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"axes": {"rows": [{"field": "symbol"}], "columns": [], "measures": [{"field": "volume", "aggregation": "SUM", "alias": "v"}]}},
    }, {}),
    ("POST", "/query/picklist", {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "field": "symbol",
    }, {}),
    ("POST", "/export", {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "export_type": "pivot_results",
            "axes": {"rows": [{"field": "symbol"}], "measures": [{"field": "volume", "aggregation": "SUM", "alias": "v"}]},
            "filters": [],
            "max_rows": 10,
            "format": "csv",
        },
    }, {}),
    ("GET", "/export/nonexistent", None, {}),
    ("GET", "/export/nonexistent/download", None, {}),
]


def _call(client: TestClient, method: str, path: str, body, params: dict, headers: dict):
    if method == "GET":
        return client.get(path, params=params, headers=headers)
    return client.post(path, json=body, headers=headers)


def _assert_auth_error_envelope(r) -> None:
    assert r.status_code == 401
    body = r.json()
    assert body["code"] == "AUTH_ERROR"
    assert "message" in body


@pytest.mark.parametrize("method,path,body,params", _PROTECTED_ENDPOINTS)
def test_missing_key_returns_401_envelope(auth_client: TestClient, method, path, body, params):
    r = _call(auth_client, method, path, body, params, headers={})
    _assert_auth_error_envelope(r)


@pytest.mark.parametrize("method,path,body,params", _PROTECTED_ENDPOINTS)
def test_invalid_key_returns_401_envelope(auth_client: TestClient, method, path, body, params):
    r = _call(auth_client, method, path, body, params, headers={"X-API-Key": INVALID_KEY})
    _assert_auth_error_envelope(r)


def test_valid_key_schema_returns_200(auth_client: TestClient):
    r = auth_client.get("/schema", params={"dataset_id": "trades_v1"}, headers={"X-API-Key": VALID_KEY})
    assert r.status_code == 200


def test_health_no_auth_required(auth_client: TestClient):
    r = auth_client.get("/health/liveness")
    assert r.status_code == 200
