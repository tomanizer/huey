"""Tests for correlation ID propagation (request tracing)."""

import logging

import pytest
from fastapi.testclient import TestClient

from server.request_context import generate_request_id, get_request_id, set_request_id


def _query_body(**overrides):
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol"}]},
    }
    body.update(overrides)
    return body


class TestRequestContext:
    def test_set_and_get(self) -> None:
        token = set_request_id("test-123")
        assert get_request_id() == "test-123"
        set_request_id("")
        token  # noqa: B018

    def test_generate_request_id_format(self) -> None:
        rid = generate_request_id()
        assert len(rid) == 8
        assert isinstance(rid, str)

    def test_default_is_empty(self) -> None:
        set_request_id("")
        assert get_request_id() == ""


class TestCorrelationIdMiddleware:
    def test_response_includes_request_id(self, client: TestClient) -> None:
        r = client.get("/health/liveness")
        assert "X-Request-ID" in r.headers
        assert r.headers["X-API-Version"] == "1"
        assert len(r.headers["X-Request-ID"]) > 0

    def test_custom_request_id_echoed(self, client: TestClient) -> None:
        r = client.get(
            "/health/liveness",
            headers={"X-Request-ID": "my-trace-123"},
        )
        assert r.headers["X-Request-ID"] == "my-trace-123"

    def test_generated_id_when_no_header(self, client: TestClient) -> None:
        r = client.get("/health/liveness")
        rid = r.headers["X-Request-ID"]
        assert len(rid) == 8

    def test_unique_ids_per_request(self, client: TestClient) -> None:
        r1 = client.get("/health/liveness")
        r2 = client.get("/health/liveness")
        assert r1.headers["X-Request-ID"] != r2.headers["X-Request-ID"]

    def test_post_endpoint_gets_correlation_id(self, client: TestClient) -> None:
        body = _query_body()
        r = client.post(f"/api/v1/datasets/{body['dataset_id']}/query/tuples", json=body)
        assert "X-Request-ID" in r.headers
        assert len(r.headers["X-Request-ID"]) > 0


class TestRequestMetadataHeaders:
    def test_request_id_header_propagates_to_tuples(self, client: TestClient) -> None:
        body = _query_body()
        r = client.post(
            f"/api/v1/datasets/{body['dataset_id']}/query/tuples",
            json=body,
            headers={"X-Request-ID": "frontend-456"},
        )
        assert r.headers["X-Request-ID"] == "frontend-456"

    def test_request_id_header_propagates_to_cells(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "axes": {
                    "rows": [{"field": "symbol"}],
                    "measures": [{"field": "volume", "aggregation": "SUM", "alias": "vol"}],
                },
            },
        }
        r = client.post(
            f"/api/v1/datasets/{body['dataset_id']}/query/cells",
            json=body,
            headers={"X-Request-ID": "cells-trace-789"},
        )
        assert r.headers["X-Request-ID"] == "cells-trace-789"

    def test_request_id_header_propagates_to_picklist(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"field": "symbol"},
        }
        r = client.post(
            f"/api/v1/datasets/{body['dataset_id']}/query/picklist",
            json=body,
            headers={"X-Request-ID": "picklist-trace-abc"},
        )
        assert r.headers["X-Request-ID"] == "picklist-trace-abc"

    def test_request_id_header_propagates_to_export(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"axes": {}, "format": "csv"},
        }
        r = client.post(
            "/api/v1/exports",
            json=body,
            headers={"X-Request-ID": "export-trace-def"},
        )
        assert r.headers["X-Request-ID"] == "export-trace-def"

    def test_client_version_header_is_logged(self, client: TestClient, caplog: "pytest.LogCaptureFixture") -> None:
        body = _query_body()
        with caplog.at_level(logging.INFO, logger="query_service.access"):
            client.post(
                f"/api/v1/datasets/{body['dataset_id']}/query/tuples",
                json=body,
                headers={"X-Client-Version": "huey-web/1.2.3"},
            )
        assert any(
            getattr(record, "client_version", "") == "huey-web/1.2.3"
            for record in caplog.records
        )

    def test_no_request_id_header_generates_one(self, client: TestClient) -> None:
        body = _query_body()
        r = client.post(
            f"/api/v1/datasets/{body['dataset_id']}/query/tuples",
            json=body,
        )
        assert len(r.headers["X-Request-ID"]) > 0


class TestLoggingIncludesRequestId:
    def test_log_records_contain_request_id(
        self, client: TestClient, caplog: "pytest.LogCaptureFixture"
    ) -> None:
        with caplog.at_level(logging.INFO, logger="query_service"):
            client.post(
                "/api/v1/datasets/trades_v1/query/tuples",
                json=_query_body(),
                headers={"X-Request-ID": "log-check-42"},
            )
        matching = [r for r in caplog.records if hasattr(r, "request_id")]
        assert len(matching) > 0
        assert any(r.request_id == "log-check-42" for r in matching)  # type: ignore[attr-defined]
