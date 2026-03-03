"""
Analytical engine integration: DuckDB in-process.

Provides a thread-safe, persistent DuckDB connection managed via DuckDBManager.
The manager is initialized at application startup and shut down on exit.
"""

import asyncio
import logging
import threading
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

import duckdb

from server.config import get_settings

logger = logging.getLogger("query_service.engine")


class DuckDBManager:
    """
    Manages a persistent DuckDB connection with thread-safe cursor access.

    Call initialize() at startup and shutdown() at exit. Use cursor() context
    manager or execute_sql() for queries. For async FastAPI handlers, use
    execute_sql_async() to run queries in a thread pool.
    """

    def __init__(self) -> None:
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
        logger.info("DuckDB connection opened", extra={"database": db_path})

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

    def execute_sql(self, sql: str, parameters: tuple[Any, ...] | None = None) -> list[list[Any]]:
        """Execute a SQL query and return rows as list of lists."""
        with self.cursor() as cur:
            if parameters:
                result = cur.execute(sql, parameters).fetchall()
            else:
                result = cur.execute(sql).fetchall()
            return [list(row) for row in result]

    async def execute_sql_async(self, sql: str, parameters: tuple[Any, ...] | None = None) -> list[list[Any]]:
        """Run SQL in a thread pool to avoid blocking the event loop."""
        return await asyncio.to_thread(self.execute_sql, sql, parameters)

    def health_check(self) -> bool:
        """Return True if the connection is alive."""
        try:
            self.execute_sql("SELECT 1")
            return True
        except Exception:
            logger.exception("DuckDB health check failed")
            return False

    @property
    def is_initialized(self) -> bool:
        return self._conn is not None


db_manager = DuckDBManager()


def get_connection() -> duckdb.DuckDBPyConnection:
    """Return a new in-memory DuckDB connection for callers that need a standalone connection (e.g. S3 reads)."""
    return duckdb.connect(":memory:")
