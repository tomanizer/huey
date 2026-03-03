"""Tests for DuckDB engine integration and DuckDBManager."""

import os

import pytest

from server.engine import DuckDBManager, get_connection
from server.errors import DatasetUnavailableError


class TestDuckDBManager:
    def test_initialize_and_shutdown(self) -> None:
        mgr = DuckDBManager()
        assert not mgr.is_initialized
        mgr.initialize()
        assert mgr.is_initialized
        mgr.shutdown()
        assert not mgr.is_initialized

    def test_double_initialize_is_safe(self) -> None:
        mgr = DuckDBManager()
        mgr.initialize()
        mgr.initialize()
        assert mgr.is_initialized
        mgr.shutdown()

    def test_shutdown_without_initialize_is_safe(self) -> None:
        mgr = DuckDBManager()
        mgr.shutdown()

    def test_execute_sql(self) -> None:
        mgr = DuckDBManager()
        mgr.initialize()
        try:
            rows = mgr.execute_sql("SELECT 1 AS x")
            assert rows == [[1]]
        finally:
            mgr.shutdown()

    def test_execute_sql_with_params(self) -> None:
        mgr = DuckDBManager()
        mgr.initialize()
        try:
            rows = mgr.execute_sql("SELECT ?::int AS v", (42,))
            assert rows == [[42]]
        finally:
            mgr.shutdown()

    def test_cursor_context_manager(self) -> None:
        mgr = DuckDBManager()
        mgr.initialize()
        try:
            with mgr.cursor() as cur:
                r = cur.execute("SELECT 99").fetchone()
                assert r == (99,)
        finally:
            mgr.shutdown()

    def test_cursor_raises_if_not_initialized(self) -> None:
        mgr = DuckDBManager()
        with pytest.raises(RuntimeError, match="not initialized"):
            with mgr.cursor():
                pass

    def test_health_check_healthy(self) -> None:
        mgr = DuckDBManager()
        mgr.initialize()
        try:
            assert mgr.health_check() is True
        finally:
            mgr.shutdown()

    def test_health_check_unhealthy(self) -> None:
        mgr = DuckDBManager()
        assert mgr.health_check() is False

    def test_missing_table_maps_to_dataset_unavailable(self) -> None:
        mgr = DuckDBManager()
        mgr.initialize()
        try:
            with pytest.raises(DatasetUnavailableError) as exc:
                mgr.execute_sql("SELECT * FROM missing_table", dataset_id="missing_ds")
            assert exc.value.code == "DATASET_UNAVAILABLE"
            assert exc.value.details["dataset_id"] == "missing_ds"
        finally:
            mgr.shutdown()

    @pytest.mark.anyio
    async def test_execute_sql_async(self) -> None:
        mgr = DuckDBManager()
        mgr.initialize()
        try:
            rows = await mgr.execute_sql_async("SELECT 7 AS v")
            assert rows == [[7]]
        finally:
            mgr.shutdown()

    def test_initialize_applies_runtime_tuning(self, monkeypatch, tmp_path) -> None:
        class MockSettings:
            data_dir = None
            duckdb_threads = 2
            duckdb_memory_limit = "512MB"
            duckdb_temp_directory = str(tmp_path / "duckdb-spill")
            duckdb_enable_object_cache = False

        monkeypatch.setattr("server.engine.get_settings", lambda: MockSettings())
        mgr = DuckDBManager()
        mgr.initialize()
        try:
            with mgr.cursor() as cur:
                assert cur.execute("SELECT current_setting('threads')").fetchone()[0] == 2
                assert cur.execute("SELECT current_setting('temp_directory')").fetchone()[0] == str(tmp_path / "duckdb-spill")
                assert cur.execute("SELECT current_setting('enable_object_cache')").fetchone()[0] is False
                assert cur.execute("SELECT current_setting('memory_limit')").fetchone()[0]
        finally:
            mgr.shutdown()

    def test_default_threads_considers_uvicorn_workers(self, monkeypatch) -> None:
        monkeypatch.setattr(os, "cpu_count", lambda: 8)
        monkeypatch.setenv("UVICORN_WORKERS", "2")
        assert DuckDBManager._resolved_default_threads() == 4

    def test_default_threads_handles_invalid_worker_env(self, monkeypatch) -> None:
        monkeypatch.setattr(os, "cpu_count", lambda: 8)
        monkeypatch.setenv("UVICORN_WORKERS", "not-a-number")
        assert DuckDBManager._resolved_default_threads() == 4


class TestGetConnection:
    def test_returns_standalone_connection(self) -> None:
        conn = get_connection()
        try:
            r = conn.execute("SELECT 2").fetchone()
            assert r == (2,)
        finally:
            conn.close()
