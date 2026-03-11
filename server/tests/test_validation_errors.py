"""Validation tests for v1 query and export request contracts."""

import pytest
from fastapi.testclient import TestClient

from server.config import get_settings

QUERY_ENDPOINTS = ["tuples", "cells", "members"]
EXPORTS_ROOT = "/api/v1/datasets/trades_v1/exports"


def _post_path(endpoint: str, dataset_id: str = "trades_v1") -> str:
    if endpoint == "tuples":
        return f"/api/v1/datasets/{dataset_id}/query/tuples"
    if endpoint == "cells":
        return f"/api/v1/datasets/{dataset_id}/query/cells"
    if endpoint == "members":
        return f"/api/v1/datasets/{dataset_id}/query/members"
    return EXPORTS_ROOT


def _valid_body_for(endpoint: str) -> dict:
    if endpoint == "tuples":
        return {
            "fields": [{"field": "symbol"}],
            "paging": {"limit": 10, "offset": 0},
            "date_range": {"type": "single", "date": "2026-03-01"},
        }
    if endpoint == "cells":
        return {
            "axes": {
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
            },
            "date_range": {"type": "single", "date": "2026-03-01"},
        }
    if endpoint == "members":
        return {
            "field": "symbol",
            "paging": {"limit": 10, "offset": 0},
            "date_range": {"type": "single", "date": "2026-03-01"},
        }
    return {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"format": "csv"},
    }


@pytest.mark.parametrize("endpoint", QUERY_ENDPOINTS)
class TestCommonQueryValidation:
    def test_empty_body(self, client: TestClient, endpoint: str) -> None:
        r = client.post(_post_path(endpoint), json={})
        assert r.status_code == 422

    def test_rejects_dataset_id_in_body(self, client: TestClient, endpoint: str) -> None:
        body = _valid_body_for(endpoint)
        body["dataset_id"] = "trades_v1"
        r = client.post(_post_path(endpoint), json=body)
        assert r.status_code == 422
        error = r.json()["details"]["errors"][0]
        assert error["loc"] == ["body", "dataset_id"]
        assert error["type"] == "extra_forbidden"

    def test_rejects_nested_query_wrapper(self, client: TestClient, endpoint: str) -> None:
        body = {"query": _valid_body_for(endpoint)}
        r = client.post(_post_path(endpoint), json=body)
        assert r.status_code == 422

    def test_date_range_at_span_limit(self, monkeypatch, client: TestClient, endpoint: str) -> None:
        monkeypatch.setenv("QUERYSERVICE_MAX_DATE_RANGE_DAYS", "2")
        get_settings.cache_clear()
        try:
            body = _valid_body_for(endpoint)
            body["date_range"] = {"type": "range", "start": "2026-03-01", "end": "2026-03-02"}
            r = client.post(_post_path(endpoint), json=body)
        finally:
            get_settings.cache_clear()
        assert r.status_code < 400

    def test_date_range_over_span_limit_has_details(
        self, monkeypatch, client: TestClient, endpoint: str
    ) -> None:
        monkeypatch.setenv("QUERYSERVICE_MAX_DATE_RANGE_DAYS", "2")
        get_settings.cache_clear()
        try:
            body = _valid_body_for(endpoint)
            body["date_range"] = {"type": "range", "start": "2026-03-01", "end": "2026-03-03"}
            r = client.post(_post_path(endpoint), json=body)
        finally:
            get_settings.cache_clear()
        assert r.status_code == 422
        payload = r.json()
        assert payload["code"] == "VALIDATION_ERROR"
        assert payload["details"]["errors"][0]["ctx"] == {"requested_days": 3, "max_days": 2}


class TestTuplesValidation:
    def test_invalid_sort_rejected(self, client: TestClient) -> None:
        body = _valid_body_for("tuples")
        body["fields"] = [{"field": "symbol", "sort": "RANDOM"}]
        r = client.post(_post_path("tuples"), json=body)
        assert r.status_code == 422

    def test_unknown_tuples_field_rejected(self, client: TestClient) -> None:
        body = _valid_body_for("tuples")
        body["fields"] = [{"field": "not_a_field"}]
        r = client.post(_post_path("tuples"), json=body)
        assert r.status_code == 422
        assert r.json()["details"]["errors"][0]["loc"] == ["body", "fields", 0, "field"]

    def test_unknown_filter_field_rejected(self, client: TestClient) -> None:
        body = _valid_body_for("tuples")
        body["filters"] = [{"field": "not_a_field", "operator": "INCLUDE", "values": ["AAPL"]}]
        r = client.post(_post_path("tuples"), json=body)
        assert r.status_code == 422
        assert r.json()["details"]["errors"][0]["loc"] == ["body", "filters", 0, "field"]

    def test_limit_bounds_rejected(self, client: TestClient) -> None:
        body = _valid_body_for("tuples")
        body["paging"] = {"limit": 0, "offset": 0}
        r = client.post(_post_path("tuples"), json=body)
        assert r.status_code == 422

    @pytest.mark.parametrize(
        ("operator", "values"),
        [
            ("gt", []),
            ("gt", [1, 2]),
            ("gte", []),
            ("lt", [1, 2]),
            ("lte", []),
            ("between", [1]),
            ("include", []),
            ("exclude", list(range(1001))),
            ("is_null", ["x"]),
            ("not_null", ["x"]),
        ],
    )
    def test_invalid_filter_shapes_return_filter_invalid(self, client: TestClient, operator: str, values: list) -> None:
        body = _valid_body_for("tuples")
        body["filters"] = [{"field": "volume", "operator": operator, "values": values}]
        r = client.post(_post_path("tuples"), json=body)
        assert r.status_code == 422
        payload = r.json()
        assert payload["code"] == "FILTER_INVALID"

    def test_filter_operators_are_case_insensitive(self, client: TestClient) -> None:
        body = _valid_body_for("tuples")
        body["filters"] = [{"field": "volume", "operator": "GT", "values": [1500]}]
        r = client.post(_post_path("tuples"), json=body)
        assert r.status_code == 200

    def test_unknown_filter_operator_returns_filter_invalid(self, client: TestClient) -> None:
        body = _valid_body_for("tuples")
        body["filters"] = [{"field": "volume", "operator": "NOPE", "values": [1500]}]
        r = client.post(_post_path("tuples"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "FILTER_INVALID"

    def test_missing_filter_operator_returns_filter_invalid(self, client: TestClient) -> None:
        body = _valid_body_for("tuples")
        body["filters"] = [{"field": "volume", "values": [1500]}]
        r = client.post(_post_path("tuples"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "FILTER_INVALID"

    def test_unknown_tuple_derivation_returns_derivation_not_supported(self, client: TestClient) -> None:
        body = _valid_body_for("tuples")
        body["fields"] = [{"field": "date", "derivation": "not_real"}]
        r = client.post(_post_path("tuples"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "DERIVATION_NOT_SUPPORTED"

    def test_type_incompatible_tuple_derivation_returns_derivation_not_supported(self, client: TestClient) -> None:
        body = _valid_body_for("tuples")
        body["fields"] = [{"field": "symbol", "derivation": "year"}]
        r = client.post(_post_path("tuples"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "DERIVATION_NOT_SUPPORTED"


class TestCellsValidation:
    def test_missing_axes_rejected(self, client: TestClient) -> None:
        body = {"date_range": {"type": "single", "date": "2026-03-01"}}
        r = client.post(_post_path("cells"), json=body)
        assert r.status_code == 422

    def test_unknown_cells_axis_or_measure_rejected(self, client: TestClient) -> None:
        body = _valid_body_for("cells")
        body["axes"] = {
            "rows": [{"field": "not_a_field"}],
            "columns": [],
            "measures": [{"field": "also_not_a_field", "aggregation": "SUM", "alias": "bad"}],
        }
        r = client.post(_post_path("cells"), json=body)
        assert r.status_code == 422
        assert len(r.json()["details"]["errors"]) == 2

    def test_invalid_aggregation_rejected(self, client: TestClient) -> None:
        body = _valid_body_for("cells")
        body["axes"]["measures"] = [{"field": "volume", "aggregation": "INVALID"}]
        r = client.post(_post_path("cells"), json=body)
        assert r.status_code == 422

    def test_first_without_sort_by_returns_sort_by_required(self, client: TestClient) -> None:
        body = _valid_body_for("cells")
        body["axes"]["measures"] = [{"field": "volume", "aggregation": "first", "alias": "first_volume"}]
        r = client.post(_post_path("cells"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "SORT_BY_REQUIRED"

    def test_histogram_returns_aggregation_not_supported(self, client: TestClient) -> None:
        body = _valid_body_for("cells")
        body["axes"]["measures"] = [{"field": "volume", "aggregation": "histogram", "alias": "volume_hist"}]
        r = client.post(_post_path("cells"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "AGGREGATION_NOT_SUPPORTED"

    def test_incompatible_aggregation_returns_aggregation_not_supported(self, client: TestClient) -> None:
        body = _valid_body_for("cells")
        body["axes"]["measures"] = [{"field": "symbol", "aggregation": "sum", "alias": "sum_symbol"}]
        r = client.post(_post_path("cells"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "AGGREGATION_NOT_SUPPORTED"

    def test_first_sort_by_field_must_exist(self, client: TestClient) -> None:
        body = _valid_body_for("cells")
        body["axes"]["measures"] = [{"field": "volume", "aggregation": "first", "alias": "first_volume", "sort_by": "missing"}]
        r = client.post(_post_path("cells"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "VALIDATION_ERROR"

    def test_unknown_cells_derivation_returns_derivation_not_supported(self, client: TestClient) -> None:
        body = _valid_body_for("cells")
        body["axes"]["rows"] = [{"field": "date", "derivation": "not_real"}]
        r = client.post(_post_path("cells"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "DERIVATION_NOT_SUPPORTED"

    def test_type_incompatible_cells_derivation_returns_derivation_not_supported(self, client: TestClient) -> None:
        body = _valid_body_for("cells")
        body["axes"]["rows"] = [{"field": "symbol", "derivation": "year"}]
        r = client.post(_post_path("cells"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "DERIVATION_NOT_SUPPORTED"


class TestMembersValidation:
    def test_unknown_members_field_rejected(self, client: TestClient) -> None:
        body = _valid_body_for("members")
        body["field"] = "not_a_field"
        r = client.post(_post_path("members"), json=body)
        assert r.status_code == 422
        assert r.json()["details"]["errors"][0]["loc"] == ["body", "field"]

    def test_offset_negative_rejected(self, client: TestClient) -> None:
        body = _valid_body_for("members")
        body["paging"] = {"limit": 10, "offset": -1}
        r = client.post(_post_path("members"), json=body)
        assert r.status_code == 422

    def test_unknown_members_derivation_returns_derivation_not_supported(self, client: TestClient) -> None:
        body = _valid_body_for("members")
        body["derivation"] = "not_real"
        r = client.post(_post_path("members"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "DERIVATION_NOT_SUPPORTED"

    def test_type_incompatible_members_derivation_returns_derivation_not_supported(self, client: TestClient) -> None:
        body = _valid_body_for("members")
        body["field"] = "symbol"
        body["derivation"] = "year"
        r = client.post(_post_path("members"), json=body)
        assert r.status_code == 422
        assert r.json()["code"] == "DERIVATION_NOT_SUPPORTED"


class TestExportValidation:
    def test_invalid_format_rejected(self, client: TestClient) -> None:
        r = client.post(
            EXPORTS_ROOT,
            json={
                "date_range": {"type": "single", "date": "2026-03-01"},
                "query": {"format": "xlsx"},
            },
        )
        assert r.status_code == 422

    def test_max_rows_exceeds_limit_rejected(self, client: TestClient) -> None:
        r = client.post(
            EXPORTS_ROOT,
            json={
                "date_range": {"type": "single", "date": "2026-03-01"},
                "query": {"max_rows": 100001},
            },
        )
        assert r.status_code == 422

    def test_export_first_without_sort_by_returns_sort_by_required(self, client: TestClient) -> None:
        r = client.post(
            EXPORTS_ROOT,
            json={
                "date_range": {"type": "single", "date": "2026-03-01"},
                "query": {
                    "axes": {"measures": [{"field": "volume", "aggregation": "first", "alias": "first_volume"}]},
                    "format": "csv",
                },
            },
        )
        assert r.status_code == 422
        assert r.json()["code"] == "SORT_BY_REQUIRED"

    def test_export_histogram_returns_aggregation_not_supported(self, client: TestClient) -> None:
        r = client.post(
            EXPORTS_ROOT,
            json={
                "date_range": {"type": "single", "date": "2026-03-01"},
                "query": {
                    "axes": {"measures": [{"field": "volume", "aggregation": "histogram", "alias": "volume_hist"}]},
                    "format": "csv",
                },
            },
        )
        assert r.status_code == 422
        assert r.json()["code"] == "AGGREGATION_NOT_SUPPORTED"

    def test_export_incompatible_aggregation_returns_aggregation_not_supported(self, client: TestClient) -> None:
        r = client.post(
            EXPORTS_ROOT,
            json={
                "date_range": {"type": "single", "date": "2026-03-01"},
                "query": {
                    "axes": {"measures": [{"field": "symbol", "aggregation": "sum", "alias": "sum_symbol"}]},
                    "format": "csv",
                },
            },
        )
        assert r.status_code == 422
        assert r.json()["code"] == "AGGREGATION_NOT_SUPPORTED"
