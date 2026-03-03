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
        r = client.post("/query/tuples", json=_query_body())
        assert "X-Request-ID" in r.headers
        assert len(r.headers["X-Request-ID"]) > 0


class TestClientContextOverride:
    def test_client_context_request_id_overrides(self, client: TestClient) -> None:
        body = _query_body(client_context={"request_id": "frontend-456"})
        r = client.post("/query/tuples", json=body)
        assert r.headers["X-Request-ID"] == "frontend-456"

    def test_client_context_on_cells(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "axes": {
                    "rows": [{"field": "symbol"}],
                    "measures": [{"field": "volume", "aggregation": "SUM", "alias": "vol"}],
                },
            },
            "client_context": {"request_id": "cells-trace-789"},
        }
        r = client.post("/query/cells", json=body)
        assert r.headers["X-Request-ID"] == "cells-trace-789"

    def test_client_context_on_picklist(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"field": "symbol"},
            "client_context": {"request_id": "picklist-trace-abc"},
        }
        r = client.post("/query/picklist", json=body)
        assert r.headers["X-Request-ID"] == "picklist-trace-abc"

    def test_client_context_on_export(self, client: TestClient) -> None:
        body = {
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {"axes": {}, "format": "csv"},
            "client_context": {"request_id": "export-trace-def"},
        }
        r = client.post("/export", json=body)
        assert r.headers["X-Request-ID"] == "export-trace-def"

    def test_no_client_context_uses_header(self, client: TestClient) -> None:
        body = _query_body()
        r = client.post(
            "/query/tuples",
            json=body,
            headers={"X-Request-ID": "header-id-999"},
        )
        assert r.headers["X-Request-ID"] == "header-id-999"


class TestLoggingIncludesRequestId:
    def test_log_records_contain_request_id(
        self, client: TestClient, caplog: "pytest.LogCaptureFixture"
    ) -> None:
        with caplog.at_level(logging.INFO, logger="query_service"):
            client.post(
                "/query/tuples",
                json=_query_body(client_context={"request_id": "log-check-42"}),
            )
        matching = [r for r in caplog.records if hasattr(r, "request_id")]
        assert len(matching) > 0
        assert any(r.request_id == "log-check-42" for r in matching)  # type: ignore[attr-defined]
