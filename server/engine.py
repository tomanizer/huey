"""
Analytical engine integration: DuckDB in-process.

Provides a thread-safe, persistent DuckDB connection managed via DuckDBManager.
The manager is initialized at application startup and shut down on exit.
"""

import asyncio
import logging
import os
import threading
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import duckdb

from server.config import get_settings
from server.errors import DatasetUnavailableError

logger = logging.getLogger("query_service.engine")


def is_missing_table_error(exc: Exception) -> bool:
    """Return True when DuckDB error indicates a missing table/catalog relation."""
    if not isinstance(exc, duckdb.CatalogException):
        return False
    msg = str(exc).lower()
    return "table with name" in msg and "does not exist" in msg


class QueryCancelHandle:
    """Thread-safe per-query cancellation handle.

    Register the active DuckDB execution connection before query execution and
    call ``cancel()`` to interrupt only that query, without affecting other
    concurrent work.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._connection: duckdb.DuckDBPyConnection | None = None

    def _set_connection(self, connection: duckdb.DuckDBPyConnection) -> None:
        with self._lock:
            self._connection = connection

    def _clear_connection(self) -> None:
        with self._lock:
            self._connection = None

    def cancel(self) -> None:
        """Interrupt the active DuckDB connection for this query only."""
        with self._lock:
            conn = self._connection
        if conn is not None:
            try:
                conn.interrupt()
            except Exception:
                pass


class DuckDBManager:
    """
    Manages a persistent DuckDB connection with thread-safe cursor access.

    Call initialize() at startup and shutdown() at exit. Use cursor() context
    manager or execute_sql() for queries. For async FastAPI handlers, use
    execute_sql_async() to run queries in a thread pool.
    """

    def __init__(self) -> None:
        """Initialize the manager with no active connection and a cursor lock."""
        self._conn: duckdb.DuckDBPyConnection | None = None
        self._lock = threading.Lock()

    def initialize(self, database: str = ":memory:") -> None:
        """Open the persistent connection. Safe to call multiple times."""
        if self._conn is not None:
            return
        settings = get_settings()
        data_dir = getattr(settings, "data_dir", None)
        db_path = data_dir if data_dir else database
        self._conn = duckdb.connect(db_path)
        self._apply_runtime_tuning(self._conn, settings)
        if getattr(settings, "execution_mode", None) == "parquet_partitioned":
            self._conn.execute("INSTALL httpfs; LOAD httpfs;")
            logger.info("DuckDB httpfs extension loaded for S3/HTTP parquet")
        logger.info("DuckDB connection opened", extra={"database": db_path})

    @staticmethod
    def _resolved_default_threads() -> int:
        """Choose a conservative thread default to avoid CPU oversubscription."""
        cpu_count = max(1, os.cpu_count() or 1)
        try:
            workers = int(os.environ.get("UVICORN_WORKERS", "1"))
        except ValueError:
            workers = 1
        workers = max(1, workers)
        return max(1, min(4, cpu_count // workers))

    def _apply_runtime_tuning(self, conn: duckdb.DuckDBPyConnection, settings: Any) -> None:
        """Apply startup/session settings for DuckDB runtime performance."""
        threads = getattr(settings, "duckdb_threads", None)
        if threads is None:
            threads = self._resolved_default_threads()
        conn.execute("SET threads = ?", [threads])

        memory_limit = getattr(settings, "duckdb_memory_limit", None)
        if memory_limit:
            conn.execute("SET memory_limit = ?", [memory_limit])

        temp_directory = getattr(settings, "duckdb_temp_directory", None)
        if temp_directory:
            Path(temp_directory).mkdir(parents=True, exist_ok=True)
            conn.execute("SET temp_directory = ?", [temp_directory])

        object_cache = getattr(settings, "duckdb_enable_object_cache", True)
        conn.execute("SET enable_object_cache = ?", [bool(object_cache)])

        with self._lock:
            cur = conn.cursor()
        try:
            active_threads = int(cur.execute("SELECT current_setting('threads')").fetchone()[0])
            active_memory_limit = str(
                cur.execute("SELECT current_setting('memory_limit')").fetchone()[0]
            )
            active_temp_directory = str(
                cur.execute("SELECT current_setting('temp_directory')").fetchone()[0]
            )
            active_object_cache = bool(
                cur.execute("SELECT current_setting('enable_object_cache')").fetchone()[0]
            )
        finally:
            cur.close()

        logger.info(
            "DuckDB runtime tuning applied",
            extra={
                "duckdb_threads": active_threads,
                "duckdb_memory_limit": active_memory_limit,
                "duckdb_temp_directory": active_temp_directory,
                "duckdb_enable_object_cache": active_object_cache,
            },
        )

    def shutdown(self) -> None:
        """Close the persistent connection."""
        if self._conn is not None:
            self._conn.close()
            logger.info("DuckDB connection closed")
            self._conn = None

    @contextmanager
    def cursor(self) -> Generator[duckdb.DuckDBPyConnection, None, None]:
        """
        Yield a thread-safe cursor from the persistent connection.

        DuckDB supports multiple cursors on a single connection; the lock
        serializes cursor creation (not query execution).
        """
        if self._conn is None:
            raise RuntimeError("DuckDBManager not initialized — call initialize() first")
        with self._lock:
            cur = self._conn.cursor()
        try:
            yield cur
        finally:
            cur.close()

    @contextmanager
    def query_connection(
        self, *, isolated: bool = False
    ) -> Generator[duckdb.DuckDBPyConnection, None, None]:
        """Yield a DuckDB execution handle for one query.

        When *isolated* is True, a duplicated connection is returned so that
        ``interrupt()`` only targets that query's work while still sharing the
        same underlying database state as the primary connection.
        """
        if self._conn is None:
            raise RuntimeError("DuckDBManager not initialized — call initialize() first")
        if not isolated:
            with self.cursor() as cur:
                yield cur
            return

        with self._lock:
            conn = self._conn.duplicate()
        try:
            yield conn
        finally:
            conn.close()

    def execute_sql(
        self,
        sql: str,
        parameters: tuple[Any, ...] | None = None,
        *,
        dataset_id: str | None = None,
        cancel_handle: "QueryCancelHandle | None" = None,
    ) -> list[list[Any]]:
        """Execute a SQL query and return rows as list of lists.

        Internally delegates to execute_sql_fetchmany to avoid materialising
        the full DuckDB result buffer in a single fetchall() call.
        """
        return self.execute_sql_fetchmany(sql, parameters, dataset_id=dataset_id, cancel_handle=cancel_handle)

    async def execute_sql_async(
        self,
        sql: str,
        parameters: tuple[Any, ...] | None = None,
        *,
        dataset_id: str | None = None,
        cancel_handle: "QueryCancelHandle | None" = None,
    ) -> list[list[Any]]:
        """Run SQL in a thread pool to avoid blocking the event loop.

        Pass *cancel_handle* to enable per-query cancellation that does not
        interfere with other concurrent queries on the shared connection.
        """
        return await asyncio.to_thread(
            self.execute_sql,
            sql,
            parameters,
            dataset_id=dataset_id,
            cancel_handle=cancel_handle,
        )

    def execute_sql_fetchmany(
        self,
        sql: str,
        parameters: tuple[Any, ...] | None = None,
        *,
        dataset_id: str | None = None,
        batch_size: int = 1000,
        cancel_handle: "QueryCancelHandle | None" = None,
    ) -> list[list[Any]]:
        """Execute SQL and return rows fetched in bounded batches via fetchmany.

        Fetching in controlled chunks avoids materialising the full DuckDB
        result buffer in one call, reducing peak memory pressure for large
        result sets while preserving the same list-of-lists return contract.

        When *cancel_handle* is provided the query executes on a duplicated
        connection that shares the same database state as the primary
        connection. This keeps cancellation scoped to the target query instead
        of interrupting unrelated concurrent requests.
        """
        with self.query_connection(isolated=cancel_handle is not None) as cur:
            if cancel_handle is not None:
                cancel_handle._set_connection(cur)
            try:
                if parameters:
                    cur.execute(sql, parameters)
                else:
                    cur.execute(sql)
                rows: list[list[Any]] = []
                while True:
                    batch = cur.fetchmany(batch_size)
                    if not batch:
                        break
                    rows.extend([list(row) for row in batch])
                return rows
            except Exception as exc:
                if dataset_id and is_missing_table_error(exc):
                    raise DatasetUnavailableError(dataset_id) from exc
                raise
            finally:
                if cancel_handle is not None:
                    cancel_handle._clear_connection()

    async def execute_sql_fetchmany_async(
        self,
        sql: str,
        parameters: tuple[Any, ...] | None = None,
        *,
        dataset_id: str | None = None,
        batch_size: int = 1000,
        cancel_handle: "QueryCancelHandle | None" = None,
    ) -> list[list[Any]]:
        """Run fetchmany-based SQL execution in a thread pool."""
        return await asyncio.to_thread(
            self.execute_sql_fetchmany,
            sql,
            parameters,
            dataset_id=dataset_id,
            batch_size=batch_size,
            cancel_handle=cancel_handle,
        )

    def table_exists(self, table_name: str) -> bool:
        """Return True when a table is present in DuckDB catalog."""
        rows = self.execute_sql(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ?",
            (table_name,),
        )
        return bool(rows and rows[0][0] > 0)

    def health_check(self) -> bool:
        """Return True if the connection is alive."""
        try:
            self.execute_sql("SELECT 1")
            return True
        except Exception:
            logger.exception("DuckDB health check failed")
            return False

    def interrupt(self) -> None:
        """Attempt to cancel in-flight queries on the shared connection."""
        if self._conn is not None:
            try:
                self._conn.interrupt()
            except Exception:
                logger.exception("Failed to interrupt DuckDB query")

    @property
    def is_initialized(self) -> bool:
        """Return True when the DuckDB connection has been opened."""
        return self._conn is not None


db_manager = DuckDBManager()


def get_connection() -> duckdb.DuckDBPyConnection:
    """Return a new in-memory DuckDB connection for callers that need a standalone connection (e.g. S3 reads)."""
    return duckdb.connect(":memory:")
