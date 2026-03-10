"""
Consolidated tests for request validation (422 errors) across all endpoints.

All Pydantic validation error tests live here. Endpoint-specific test files
focus on happy-path / business-logic tests only.
"""

import pytest
from fastapi.testclient import TestClient

from server.config import get_settings

QUERY_ENDPOINTS = ["tuples", "cells", "picklist"]
ALL_POST_ENDPOINTS = [*QUERY_ENDPOINTS, "export"]
EXPORTS_ROOT = "/api/v1/exports"

_BASE_BODY = {
    "dataset_id": "trades_v1",
    "date_range": {"type": "single", "date": "2026-03-01"},
    "query": {},
}


def _body(**query_overrides):
    """Build a valid base body with query overrides."""
    body = {**_BASE_BODY, "query": {**_BASE_BODY["query"], **query_overrides}}
    return body


def _valid_body_for(endpoint: str) -> dict:
    if endpoint == "tuples":
        return _body(fields=[{"field": "symbol"}], paging={"limit": 10, "offset": 0})
    if endpoint == "cells":
        return _body(
            axes={
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
            }
        )
    if endpoint == "picklist":
        return _body(field="symbol", paging={"limit": 10, "offset": 0})
    return {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"format": "csv"},
    }


def _post_path(endpoint: str, body: dict) -> str:
    dataset_id = body.get("dataset_id", "trades_v1")
    if endpoint == "tuples":
        return f"/api/v1/datasets/{dataset_id}/query/tuples"
    if endpoint == "cells":
        return f"/api/v1/datasets/{dataset_id}/query/cells"
    if endpoint == "picklist":
        return f"/api/v1/datasets/{dataset_id}/query/picklist"
    return EXPORTS_ROOT


@pytest.mark.parametrize("endpoint", ALL_POST_ENDPOINTS)
class TestCommonValidation:
    """Validation scenarios shared across all POST endpoints."""

    def test_empty_body(self, client: TestClient, endpoint: str) -> None:
        r = client.post(_post_path(endpoint, {}), json={})
        assert r.status_code == 422

    def test_missing_dataset_id(self, client: TestClient, endpoint: str) -> None:
        r = client.post(_post_path(endpoint, {}), json={
            "date_range": {"type": "single", "date": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_dataset_id_wrong_type(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": 123,
            "date_range": {"type": "single", "date": "2026-01-01"},
            "query": {},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    def test_date_range_null(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": None,
            "query": {},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    def test_date_range_empty_object(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {},
            "query": {},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    def test_date_range_unknown_type(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "weekly", "date": "2026-01-01"},
            "query": {},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    def test_date_bad_format(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "not-a-date"},
            "query": {},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    def test_date_invalid_calendar_value(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-02-30"},
            "query": {},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    def test_date_range_inverted(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "range", "start": "2026-12-01", "end": "2026-01-01"},
            "query": {},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    def test_date_range_missing_end(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "range", "start": "2026-01-01"},
            "query": {},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    def test_date_range_missing_date_field(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single"},
            "query": {},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    def test_date_range_invalid_calendar_value(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "range", "start": "2026-01-01", "end": "2026-13-01"},
            "query": {},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    def test_date_range_at_span_limit(self, monkeypatch, client: TestClient, endpoint: str) -> None:
        monkeypatch.setenv("QUERYSERVICE_MAX_DATE_RANGE_DAYS", "2")
        get_settings.cache_clear()
        try:
            body = _valid_body_for(endpoint)
            body["date_range"] = {"type": "range", "start": "2026-03-01", "end": "2026-03-02"}
            r = client.post(_post_path(endpoint, body), json=body)
        finally:
            get_settings.cache_clear()
        assert r.status_code < 400

    def test_date_range_over_span_limit_has_details(
        self, monkeypatch, client: TestClient, endpoint: str
    ) -> None:
        monkeypatch.setenv("QUERYSERVICE_MAX_DATE_RANGE_DAYS", "2")
        get_settings.cache_clear()
        try:
            request_body = _valid_body_for(endpoint)
            request_body["date_range"] = {"type": "range", "start": "2026-03-01", "end": "2026-03-03"}
            r = client.post(_post_path(endpoint, request_body), json=request_body)
        finally:
            get_settings.cache_clear()
        assert r.status_code == 422
        resp_body = r.json()
        assert resp_body["code"] == "VALIDATION_ERROR"
        assert resp_body["details"]["errors"][0]["ctx"] == {"requested_days": 3, "max_days": 2}
        assert "exceeds configured max of 2" in resp_body["details"]["errors"][0]["msg"]

    def test_not_json(self, client: TestClient, endpoint: str) -> None:
        r = client.post(_post_path(endpoint, {}), content="not json", headers={"Content-Type": "application/json"})
        assert r.status_code == 422


class TestFilterValidation:
    """Filter operator and value validation."""

    def test_filter_missing_operator(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "fields": [{"field": "symbol"}],
                "filters": [{"field": "symbol", "values": ["AAPL"]}],
            },
        }
        r = client.post(_post_path("tuples", body), json=body)
        assert r.status_code == 422


class TestVersionedDatasetIdValidation:
    @pytest.mark.parametrize("endpoint", QUERY_ENDPOINTS)
    def test_dataset_id_must_match_path(self, client: TestClient, endpoint: str) -> None:
        body = _valid_body_for(endpoint)
        body["dataset_id"] = "trades_v1"
        r = client.post(f"/api/v1/datasets/other_ds/query/{endpoint}", json=body)
        assert r.status_code == 422
        payload = r.json()
        assert payload["code"] == "VALIDATION_ERROR"
        error = payload["details"]["errors"][0]
        assert error["loc"] == ["body", "dataset_id"]
        assert error["type"] == "value_error.dataset_id_mismatch"
        assert error["ctx"] == {
            "path_dataset_id": "other_ds",
            "body_dataset_id": "trades_v1",
        }

    def test_filter_missing_values(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "fields": [{"field": "symbol"}],
                "filters": [{"field": "symbol", "operator": "INCLUDE"}],
            },
        }
        r = client.post(_post_path("tuples", body), json=body)
        assert r.status_code == 422

    def test_invalid_operator_rejected(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "fields": [{"field": "symbol"}],
                "filters": [{"field": "symbol", "operator": "INVALID", "values": ["x"]}],
            },
        }
        r = client.post(_post_path("tuples", body), json=body)
        assert r.status_code == 422

    def test_lowercase_operator_rejected(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "fields": [{"field": "symbol"}],
                "filters": [{"field": "symbol", "operator": "include", "values": ["x"]}],
            },
        }
        r = client.post(_post_path("tuples", body), json=body)
        assert r.status_code == 422


class TestSortValidation:
    """Sort direction validation."""

    def test_invalid_sort_rejected(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "fields": [{"field": "symbol", "sort": "RANDOM"}],
            },
        }
        r = client.post(_post_path("tuples", body), json=body)
        assert r.status_code == 422

    def test_lowercase_sort_rejected(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "fields": [{"field": "symbol", "sort": "asc"}],
            },
        }
        r = client.post(_post_path("tuples", body), json=body)
        assert r.status_code == 422


class TestPagingValidation:
    """Paging bounds validation across tuples and picklist endpoints."""

    @pytest.mark.parametrize("endpoint", ["tuples", "picklist"])
    def test_limit_zero_rejected(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"fields": [{"field": "symbol"}], "field": "symbol", "paging": {"limit": 0}},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    @pytest.mark.parametrize("endpoint", ["tuples", "picklist"])
    def test_limit_negative_rejected(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"fields": [{"field": "symbol"}], "field": "symbol", "paging": {"limit": -5}},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    @pytest.mark.parametrize("endpoint", ["tuples", "picklist"])
    def test_limit_exceeds_max_rejected(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"fields": [{"field": "symbol"}], "field": "symbol", "paging": {"limit": 10001}},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422

    @pytest.mark.parametrize("endpoint", ["tuples", "picklist"])
    def test_offset_negative_rejected(self, client: TestClient, endpoint: str) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"fields": [{"field": "symbol"}], "field": "symbol", "paging": {"offset": -1}},
        }
        r = client.post(_post_path(endpoint, body), json=body)
        assert r.status_code == 422


class TestAxesValidation:
    """Typed axes model validation — invalid aggregation rejected at parse time."""

    def test_invalid_aggregation_in_cells_rejected(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "axes": {
                    "rows": [{"field": "symbol"}],
                    "measures": [{"field": "volume", "aggregation": "INVALID"}],
                },
            },
        }
        r = client.post(_post_path("cells", body), json=body)
        assert r.status_code == 422
        body = r.json()
        assert body["code"] == "VALIDATION_ERROR"

    def test_invalid_aggregation_in_export_rejected(self, client: TestClient) -> None:
        r = client.post("/api/v1/exports", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "axes": {
                    "rows": [{"field": "symbol"}],
                    "measures": [{"field": "volume", "aggregation": "MEDIAN"}],
                },
            },
        })
        assert r.status_code == 422
        body = r.json()
        assert body["code"] == "VALIDATION_ERROR"


class TestExportValidation:
    """Export-specific field validation."""

    def test_invalid_format_rejected(self, client: TestClient) -> None:
        r = client.post("/api/v1/exports", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"format": "xlsx"},
        })
        assert r.status_code == 422

    def test_max_rows_zero_rejected(self, client: TestClient) -> None:
        r = client.post("/api/v1/exports", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"max_rows": 0},
        })
        assert r.status_code == 422

    def test_max_rows_negative_rejected(self, client: TestClient) -> None:
        r = client.post("/api/v1/exports", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"max_rows": -10},
        })
        assert r.status_code == 422

    def test_max_rows_exceeds_limit_rejected(self, client: TestClient) -> None:
        r = client.post("/api/v1/exports", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"max_rows": 100001},
        })
        assert r.status_code == 422


class TestSchemaValidation:
    def test_missing_dataset_id_param(self, client: TestClient) -> None:
        r = client.get("/api/v1/datasets//schema")
        assert r.status_code == 404


class TestUnknownSchemaFields:
    def test_unknown_tuples_field_rejected(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"fields": [{"field": "not_a_field"}]},
        }
        r = client.post(_post_path("tuples", body), json=body)
        assert r.status_code == 422
        body = r.json()
        assert body["code"] == "VALIDATION_ERROR"
        assert body["details"]["errors"][0]["loc"] == ["body", "query", "fields", 0, "field"]

    def test_unknown_filter_field_rejected(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "fields": [{"field": "symbol"}],
                "filters": [{"field": "not_a_field", "operator": "INCLUDE", "values": ["AAPL"]}],
            },
        }
        r = client.post(_post_path("tuples", body), json=body)
        assert r.status_code == 422
        body = r.json()
        assert body["code"] == "VALIDATION_ERROR"
        assert body["details"]["errors"][0]["loc"] == ["body", "query", "filters", 0, "field"]

    def test_unknown_cells_axis_or_measure_rejected(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "axes": {
                    "rows": [{"field": "not_a_field"}],
                    "columns": [],
                    "measures": [{"field": "also_not_a_field", "aggregation": "SUM", "alias": "bad"}],
                },
            },
        }
        r = client.post(_post_path("cells", body), json=body)
        assert r.status_code == 422
        body = r.json()
        assert body["code"] == "VALIDATION_ERROR"
        assert len(body["details"]["errors"]) == 2

    def test_unknown_picklist_field_rejected(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"field": "not_a_field"},
        }
        r = client.post(_post_path("picklist", body), json=body)
        assert r.status_code == 422
        body = r.json()
        assert body["code"] == "VALIDATION_ERROR"
        assert body["details"]["errors"][0]["loc"] == ["body", "query", "field"]

    def test_unknown_export_field_rejected(self, client: TestClient) -> None:
        r = client.post("/api/v1/exports", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "format": "csv",
                "axes": {"rows": [{"field": "not_a_field"}], "measures": []},
            },
        })
        assert r.status_code == 422
        body = r.json()
        assert body["code"] == "VALIDATION_ERROR"
        assert body["details"]["errors"][0]["loc"] == ["body", "query", "axes", "rows", 0, "field"]
