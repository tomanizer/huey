"""Tests for structured logging configuration and access log middleware."""

import json
import logging

from fastapi.testclient import TestClient

from server.logging_config import setup_logging


class TestSetupLogging:
    def test_json_format_produces_valid_json(self, capfd) -> None:
        setup_logging("INFO", "json")
        test_logger = logging.getLogger("test.json")
        test_logger.info("hello", extra={"key": "val"})

        captured = capfd.readouterr()
        record = json.loads(captured.out.strip())
        assert record["message"] == "hello"
        assert record["level"] == "INFO"
        assert record["key"] == "val"
        assert "timestamp" in record

    def test_json_format_includes_extra_fields(self, capfd) -> None:
        setup_logging("INFO", "json")
        test_logger = logging.getLogger("test.json.extra")
        test_logger.info("query done", extra={"duration_ms": 12.5, "row_count": 42})

        record = json.loads(capfd.readouterr().out.strip())
        assert record["duration_ms"] == 12.5
        assert record["row_count"] == 42

    def test_text_format_produces_readable_output(self, capfd) -> None:
        setup_logging("INFO", "text")
        test_logger = logging.getLogger("test.text")
        test_logger.info("startup")

        captured = capfd.readouterr()
        assert "[INFO]" in captured.out
        assert "test.text" in captured.out
        assert "startup" in captured.out

    def test_text_is_default_format(self, capfd) -> None:
        setup_logging("INFO")
        test_logger = logging.getLogger("test.default")
        test_logger.info("check")

        captured = capfd.readouterr()
        assert "[INFO]" in captured.out
        assert "check" in captured.out

    def test_log_level_respected(self, capfd) -> None:
        setup_logging("WARNING", "text")
        test_logger = logging.getLogger("test.level")
        test_logger.info("should not appear")
        test_logger.warning("should appear")

        captured = capfd.readouterr()
        assert "should not appear" not in captured.out
        assert "should appear" in captured.out

    def test_clears_existing_handlers(self) -> None:
        setup_logging("INFO", "text")
        handler_count_1 = len(logging.getLogger().handlers)
        setup_logging("INFO", "json")
        handler_count_2 = len(logging.getLogger().handlers)
        assert handler_count_1 == 1
        assert handler_count_2 == 1


class TestAccessLogMiddleware:
    def test_logs_request_details(self, client: TestClient, capfd) -> None:
        setup_logging("INFO", "json")
        client.get("/health/liveness")

        output = capfd.readouterr().out
        lines = [line for line in output.strip().split("\n") if line.strip()]
        access_records = []
        for line in lines:
            try:
                record = json.loads(line)
                if record.get("path") == "/health/liveness":
                    access_records.append(record)
            except json.JSONDecodeError:
                continue

        assert len(access_records) >= 1
        rec = access_records[0]
        assert rec["method"] == "GET"
        assert rec["status_code"] == 200
        assert "duration_ms" in rec

    def test_logs_post_request(self, client: TestClient, capfd) -> None:
        setup_logging("INFO", "json")
        client.post("/api/v1/datasets/trades_v1/query/tuples", json={
            "date_range": {"type": "single", "date": "2026-03-01"},
            "fields": [{"field": "symbol"}],
        })

        output = capfd.readouterr().out
        lines = output.strip().split("\n")
        access_records = []
        for line in lines:
            try:
                record = json.loads(line)
                if record.get("path") == "/api/v1/datasets/trades_v1/query/tuples":
                    access_records.append(record)
            except json.JSONDecodeError:
                continue

        assert len(access_records) >= 1
        assert access_records[0]["method"] == "POST"
        assert access_records[0]["status_code"] == 200


class TestQueryExecutionLogging:
    def test_tuples_query_logged(self, client: TestClient, capfd) -> None:
        setup_logging("INFO", "json")
        client.post("/api/v1/datasets/trades_v1/query/tuples", json={
            "date_range": {"type": "single", "date": "2026-03-01"},
            "fields": [{"field": "symbol"}],
        })

        output = capfd.readouterr().out
        query_records = []
        for line in output.strip().split("\n"):
            try:
                record = json.loads(line)
                if record.get("endpoint") == "tuples":
                    query_records.append(record)
            except json.JSONDecodeError:
                continue

        assert len(query_records) >= 1
        rec = query_records[0]
        assert rec["dataset_id"] == "trades_v1"
        assert "duration_ms" in rec
        assert "row_count" in rec

    def test_cells_query_logged(self, client: TestClient, capfd) -> None:
        setup_logging("INFO", "json")
        client.post("/api/v1/datasets/trades_v1/query/cells", json={
            "date_range": {"type": "single", "date": "2026-03-01"},
            "axes": {"rows": [{"field": "symbol"}], "columns": [], "measures": []},
        })

        output = capfd.readouterr().out
        query_records = [
            json.loads(line) for line in output.strip().split("\n")
            if "endpoint" in line and "cells" in line
        ]
        assert len(query_records) >= 1
        assert query_records[0]["endpoint"] == "cells"

    def test_members_query_logged(self, client: TestClient, capfd) -> None:
        setup_logging("INFO", "json")
        client.post("/api/v1/datasets/trades_v1/query/members", json={
            "date_range": {"type": "single", "date": "2026-03-01"},
            "field": "symbol",
        })

        output = capfd.readouterr().out
        query_records = [
            json.loads(line) for line in output.strip().split("\n")
            if "endpoint" in line and "members" in line
        ]
        assert len(query_records) >= 1
        assert query_records[0]["endpoint"] == "members"
