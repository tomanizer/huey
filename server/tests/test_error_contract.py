"""
Tests for the standardized error contract (#99).

Verifies that all API error responses conform to the ErrorResponse schema
(code, message, optional request_id, optional details) across all endpoints.
"""

import time

import pytest
from starlette.testclient import TestClient

from server.errors import (
    AppError,
    DatasetNotFoundError,
    ExportFileNotFoundError,
    ExportNotFoundError,
    ExportNotReadyError,
    TooManyConcurrentExportsError,
)
from server.routers import export as export_module


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
        export_module._exports["exp-pending"] = {"status": "processing", "created_at": time.time()}
        r = client.get("/export/exp-pending/download")
        assert r.status_code == 409
        body = r.json()
        assert body["code"] == "EXPORT_NOT_READY"
        assert body["details"]["status"] == "processing"
        export_module._exports.pop("exp-pending", None)

    def test_export_file_missing_404_envelope(self, client: TestClient) -> None:
        export_module._exports["exp-gone"] = {
            "status": "complete",
            "created_at": time.time(),
            "file_path": "/tmp/nonexistent.csv",
            "download_url": "/export/exp-gone/download",
        }
        r = client.get("/export/exp-gone/download")
        assert r.status_code == 404
        body = r.json()
        assert body["code"] == "EXPORT_FILE_NOT_FOUND"
        export_module._exports.pop("exp-gone", None)

    def test_too_many_exports_429_envelope(self, client: TestClient) -> None:
        for i in range(5):
            export_module._exports[f"exp-active-{i}"] = {"status": "processing", "created_at": time.time()}
        r = client.post("/export", json=_export_body())
        assert r.status_code == 429
        body = r.json()
        assert body["code"] == "TOO_MANY_EXPORTS"
        assert body["details"]["max_concurrent"] == 5
        for i in range(5):
            export_module._exports.pop(f"exp-active-{i}", None)


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
