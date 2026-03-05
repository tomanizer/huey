"""
Tests for the standardized error contract (#99).

Verifies that all API error responses conform to the ErrorResponse schema
(code, message, optional request_id, optional details) across all endpoints.
"""

import pytest
from starlette.testclient import TestClient

from server.errors import (
    AppError,
    DatasetNotFoundError,
    DatasetUnavailableError,
    ExportFileNotFoundError,
    ExportNotFoundError,
    ExportNotReadyError,
    TooManyConcurrentExportsError,
)
from server.export_service import get_export_service


@pytest.fixture(autouse=True)
def _clear_export_jobs():
    """Reset the export store between tests."""
    svc = get_export_service()
    store = svc.store
    with store._lock:
        store._conn.execute("DELETE FROM export_jobs")
        store._conn.commit()
    yield
    with store._lock:
        store._conn.execute("DELETE FROM export_jobs")
        store._conn.commit()


def _query_body(dataset_id: str = "trades_v1") -> dict:
    return {
        "dataset_id": dataset_id,
        "date_range": {"type": "single", "date": "2024-01-15"},
        "query": {},
    }


def _export_body(dataset_id: str = "trades_v1") -> dict:
    return {
        "dataset_id": dataset_id,
        "date_range": {"type": "single", "date": "2024-01-15"},
        "query": {"max_rows": 10},
    }


class TestErrorResponseSchema:
    """Every error response must contain at least 'code' and 'message'."""

    @pytest.mark.parametrize("endpoint", ["/query/tuples", "/query/cells", "/query/picklist"])
    def test_query_404_envelope(self, client: TestClient, endpoint: str) -> None:
        r = client.post(endpoint, json=_query_body(dataset_id="no_such"))
        assert r.status_code == 404
        body = r.json()
        assert body["code"] == "DATASET_NOT_FOUND"
        assert "no_such" in body["message"]
        assert "details" in body
        assert body["details"]["dataset_id"] == "no_such"

    def test_schema_404_envelope(self, client: TestClient) -> None:
        r = client.get("/schema?dataset_id=no_such")
        assert r.status_code == 404
        body = r.json()
        assert body["code"] == "DATASET_NOT_FOUND"
        assert body["details"]["dataset_id"] == "no_such"

    def test_export_post_404_envelope(self, client: TestClient) -> None:
        r = client.post("/export", json=_export_body(dataset_id="no_such"))
        assert r.status_code == 404
        body = r.json()
        assert body["code"] == "DATASET_NOT_FOUND"

    def test_export_status_404_envelope(self, client: TestClient) -> None:
        r = client.get("/export/exp-nonexistent")
        assert r.status_code == 404
        body = r.json()
        assert body["code"] == "EXPORT_NOT_FOUND"
        assert body["details"]["export_id"] == "exp-nonexistent"

    def test_export_download_404_envelope(self, client: TestClient) -> None:
        r = client.get("/export/exp-nonexistent/download")
        assert r.status_code == 404
        body = r.json()
        assert body["code"] == "EXPORT_NOT_FOUND"

    def test_export_not_ready_409_envelope(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-pending", "trades_v1")
        store.update_status("exp-pending", "processing")
        r = client.get("/export/exp-pending/download")
        assert r.status_code == 409
        body = r.json()
        assert body["code"] == "EXPORT_NOT_READY"
        assert body["details"]["status"] == "processing"

    def test_export_file_missing_404_envelope(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-gone", "trades_v1")
        store.update_status("exp-gone", "processing")
        store.update_status(
            "exp-gone", "complete",
            file_path="/tmp/nonexistent.csv",
            download_url="/export/exp-gone/download",
        )
        r = client.get("/export/exp-gone/download")
        assert r.status_code == 404
        body = r.json()
        assert body["code"] == "EXPORT_FILE_NOT_FOUND"

    def test_too_many_exports_429_envelope(self, client: TestClient) -> None:
        store = get_export_service().store
        for i in range(5):
            store.create(f"exp-active-{i}", "trades_v1")
            store.update_status(f"exp-active-{i}", "processing")
        r = client.post("/export", json=_export_body())
        assert r.status_code == 429
        body = r.json()
        assert body["code"] == "TOO_MANY_EXPORTS"
        assert body["details"]["max_concurrent"] == 5

    @pytest.mark.parametrize("endpoint", ["/query/tuples", "/query/cells", "/query/picklist"])
    def test_query_409_dataset_unavailable_envelope(self, client: TestClient, endpoint: str, monkeypatch) -> None:
        import server.routers.query as query_router

        monkeypatch.setattr(
            query_router.datasets,
            "get_schema",
            lambda dataset_id: {"dataset_id": dataset_id, "fields": [{"name": "symbol"}, {"name": "date"}]},
        )
        monkeypatch.setattr(
            query_router.datasets,
            "get_schema_field_names",
            lambda _dataset_id: {"symbol", "date", "volume"},
        )
        original_execute = query_router.db_manager.execute_sql_fetchmany_async

        async def execute_raise_unavailable(*args, **kwargs):
            # Router may pass (sql, params) or (sql, params, dataset_id=...); detect dataset from SQL/params
            call_str = str(args) + str(kwargs)
            if "not_materialized_ds" in call_str:
                raise DatasetUnavailableError("not_materialized_ds")
            return await original_execute(*args, **kwargs)

        monkeypatch.setattr(query_router.db_manager, "execute_sql_fetchmany_async", execute_raise_unavailable)

        body = _query_body(dataset_id="not_materialized_ds")
        if endpoint == "/query/tuples":
            body["query"] = {"fields": [{"field": "symbol"}]}
        elif endpoint == "/query/picklist":
            body["query"] = {"field": "symbol"}
        else:
            body["query"] = {
                "axes": {
                    "rows": [{"field": "symbol"}],
                    "columns": [],
                    "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_vol"}],
                },
            }

        r = client.post(endpoint, json=body)
        assert r.status_code == 409
        payload = r.json()
        assert payload["code"] == "DATASET_UNAVAILABLE"
        assert payload["details"]["dataset_id"] == "not_materialized_ds"

    def test_export_post_409_dataset_unavailable_envelope(self, client: TestClient, monkeypatch) -> None:
        import server.routers.export as export_router
        from server.config import get_settings

        # table_exists check only fires in sample_table mode
        monkeypatch.setenv("QUERYSERVICE_EXECUTION_MODE", "sample_table")
        get_settings.cache_clear()
        monkeypatch.setattr(
            export_router.datasets,
            "get_schema",
            lambda dataset_id: {"dataset_id": dataset_id, "fields": [{"name": "symbol"}]},
        )
        monkeypatch.setattr(export_router.db_manager, "table_exists", lambda _dataset_id: False)
        r = client.post("/export", json=_export_body(dataset_id="not_materialized_ds"))
        get_settings.cache_clear()
        assert r.status_code == 409
        payload = r.json()
        assert payload["code"] == "DATASET_UNAVAILABLE"
        assert payload["details"]["dataset_id"] == "not_materialized_ds"


class TestValidationErrorEnvelope:
    """422 validation errors wrap Pydantic details in standard envelope."""

    def test_missing_required_field(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={"query": {}})
        assert r.status_code == 422
        body = r.json()
        assert body["code"] == "VALIDATION_ERROR"
        assert body["message"] == "Request validation failed"
        assert "errors" in body["details"]
        assert isinstance(body["details"]["errors"], list)
        assert len(body["details"]["errors"]) > 0

    def test_invalid_date_format(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "not-a-date"},
        })
        assert r.status_code == 422
        body = r.json()
        assert body["code"] == "VALIDATION_ERROR"

    def test_invalid_filter_operator(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2024-01-15"},
            "query": {"filters": [{"field": "symbol", "operator": "NOPE", "values": ["X"]}]},
        })
        assert r.status_code == 422
        body = r.json()
        assert body["code"] == "VALIDATION_ERROR"

    def test_export_invalid_format(self, client: TestClient) -> None:
        r = client.post("/export", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2024-01-15"},
            "query": {"format": "xlsx"},
        })
        assert r.status_code == 422
        body = r.json()
        assert body["code"] == "VALIDATION_ERROR"


class TestRequestIdInErrors:
    """Error responses include request_id when a correlation ID is active."""

    def test_request_id_from_header(self, client: TestClient) -> None:
        r = client.post(
            "/query/tuples",
            json=_query_body(dataset_id="no_such"),
            headers={"X-Request-ID": "trace-abc"},
        )
        assert r.status_code == 404
        body = r.json()
        assert body.get("request_id") == "trace-abc"

    def test_request_id_auto_generated(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json=_query_body(dataset_id="no_such"))
        assert r.status_code == 404
        body = r.json()
        assert "request_id" in body
        assert len(body["request_id"]) > 0


class TestDomainExceptions:
    """Unit tests for exception classes."""

    def test_app_error_attributes(self) -> None:
        err = AppError(code="TEST", message="test msg", status_code=418, details={"k": "v"})
        assert err.code == "TEST"
        assert err.message == "test msg"
        assert err.status_code == 418
        assert err.details == {"k": "v"}
        assert str(err) == "test msg"

    def test_dataset_not_found(self) -> None:
        err = DatasetNotFoundError("ds1")
        assert err.code == "DATASET_NOT_FOUND"
        assert err.status_code == 404
        assert err.details["dataset_id"] == "ds1"

    def test_dataset_unavailable(self) -> None:
        err = DatasetUnavailableError("ds1")
        assert err.code == "DATASET_UNAVAILABLE"
        assert err.status_code == 409
        assert err.details["dataset_id"] == "ds1"

    def test_export_not_found(self) -> None:
        err = ExportNotFoundError("exp-1")
        assert err.code == "EXPORT_NOT_FOUND"
        assert err.status_code == 404

    def test_export_not_ready(self) -> None:
        err = ExportNotReadyError("exp-1", "processing")
        assert err.code == "EXPORT_NOT_READY"
        assert err.status_code == 409
        assert err.details["status"] == "processing"

    def test_export_file_not_found(self) -> None:
        err = ExportFileNotFoundError("exp-1")
        assert err.code == "EXPORT_FILE_NOT_FOUND"
        assert err.status_code == 404

    def test_too_many_exports(self) -> None:
        err = TooManyConcurrentExportsError(5)
        assert err.code == "TOO_MANY_EXPORTS"
        assert err.status_code == 429
        assert err.details["max_concurrent"] == 5


class TestInternalErrorEnvelope:
    """Unhandled exceptions return INTERNAL_ERROR without leaking stack traces."""

    def test_unhandled_exception_returns_500_envelope(self, monkeypatch) -> None:
        import server.routers.query as query_router
        from server.main import app

        async def boom(*args, **kwargs):
            raise RuntimeError("unexpected failure")

        monkeypatch.setattr(query_router.db_manager, "execute_sql_fetchmany_async", boom)
        # raise_server_exceptions=False so we get the HTTP response instead of the re-raised exception
        no_raise_client = TestClient(app, raise_server_exceptions=False)
        r = no_raise_client.post("/query/cells", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"axes": {"rows": [{"field": "symbol"}], "columns": [], "measures": [{"field": "volume", "aggregation": "SUM", "alias": "v"}]}},
        })
        assert r.status_code == 500
        body = r.json()
        assert body["code"] == "INTERNAL_ERROR"
        assert "message" in body
        # No raw exception message or traceback in the response body
        assert "unexpected failure" not in str(body)


class TestHappyPathUnchanged:
    """Regression: successful requests still return normal responses (no error envelope)."""

    def test_health_liveness(self, client: TestClient) -> None:
        r = client.get("/health/liveness")
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}

    def test_health_readiness(self, client: TestClient) -> None:
        r = client.get("/health/readiness")
        assert r.status_code == 200

    def test_schema_success(self, client: TestClient) -> None:
        r = client.get("/schema?dataset_id=trades_v1")
        assert r.status_code == 200
        assert "fields" in r.json()

    def test_query_tuples_success(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json=_query_body())
        assert r.status_code == 200
        assert "items" in r.json()

    def test_query_cells_success(self, client: TestClient) -> None:
        r = client.post("/query/cells", json=_query_body())
        assert r.status_code == 200
        assert "cells" in r.json()

    def test_query_picklist_success(self, client: TestClient) -> None:
        r = client.post("/query/picklist", json=_query_body())
        assert r.status_code == 200
        assert "values" in r.json()
