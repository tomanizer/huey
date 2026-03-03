"""
Consolidated tests for request validation (422 errors) across all endpoints.

All Pydantic validation error tests live here. Endpoint-specific test files
focus on happy-path / business-logic tests only.
"""

import pytest
from fastapi.testclient import TestClient

QUERY_ENDPOINTS = ["/query/tuples", "/query/cells", "/query/picklist"]
ALL_POST_ENDPOINTS = [*QUERY_ENDPOINTS, "/export"]


@pytest.mark.parametrize("endpoint", ALL_POST_ENDPOINTS)
class TestCommonValidation:
    """Validation scenarios shared across all POST endpoints."""

    def test_empty_body(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, json={})
        assert r.status_code == 422

    def test_missing_dataset_id(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, json={
            "date_range": {"type": "single", "date": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_dataset_id_wrong_type(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, json={
            "dataset_id": 123,
            "date_range": {"type": "single", "date": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_date_range_null(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, json={
            "dataset_id": "trades_v1",
            "date_range": None,
            "query": {},
        })
        assert r.status_code == 422

    def test_date_range_empty_object(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, json={
            "dataset_id": "trades_v1",
            "date_range": {},
            "query": {},
        })
        assert r.status_code == 422

    def test_date_range_unknown_type(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "weekly", "date": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_date_bad_format(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "not-a-date"},
            "query": {},
        })
        assert r.status_code == 422

    def test_date_range_inverted(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "range", "start": "2026-12-01", "end": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_date_range_missing_end(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "range", "start": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_date_range_missing_date_field(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single"},
            "query": {},
        })
        assert r.status_code == 422

    def test_not_json(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, content="not json", headers={"Content-Type": "application/json"})
        assert r.status_code == 422


class TestTuplesFilterValidation:
    """Filter-specific validation for /query/tuples."""

    def test_filter_missing_operator(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "fields": [{"field": "symbol"}],
                "filters": [{"field": "symbol", "values": ["AAPL"]}],
            },
        })
        assert r.status_code == 422

    def test_filter_missing_values(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "fields": [{"field": "symbol"}],
                "filters": [{"field": "symbol", "operator": "INCLUDE"}],
            },
        })
        assert r.status_code == 422


class TestSchemaValidation:
    def test_missing_dataset_id_param(self, client: TestClient) -> None:
        r = client.get("/schema")
        assert r.status_code == 422
