"""
SQLite-backed export job store.

Provides durable persistence for export job metadata that survives process
restarts and supports concurrent access from multiple workers via WAL mode.
"""

import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ExportJob:
    """Represents a single export job record."""

    id: str
    status: str  # pending | processing | complete | failed | expired | cancelled
    dataset_id: str
    format: str
    created_at: float
    updated_at: float
    file_path: str | None = None
    download_url: str | None = None
    row_count: int | None = None
    size_bytes: int | None = None
    completed_at: float | None = None
    error_message: str | None = None


VALID_STATUSES = frozenset({"pending", "processing", "complete", "failed", "expired", "cancelled"})

_VALID_TRANSITIONS = {
    "pending": {"processing", "failed", "expired", "cancelled"},
    "processing": {"complete", "failed", "expired", "cancelled"},
    "complete": {"expired"},
    "failed": {"expired"},
    "cancelled": set(),
    "expired": set(),
}

_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS export_jobs (
    id            TEXT PRIMARY KEY,
    status        TEXT NOT NULL DEFAULT 'pending',
    dataset_id    TEXT NOT NULL,
    format        TEXT NOT NULL DEFAULT 'parquet',
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL,
    file_path     TEXT,
    download_url  TEXT,
    row_count     INTEGER,
    size_bytes    INTEGER,
    completed_at  REAL,
    error_message TEXT
)
"""


class ExportJobStore:
    """Thread-safe, SQLite-backed repository for export job records.

    Supports both file-backed (durable) and :memory: (testing) databases.
    Uses WAL journal mode for file-backed DBs to allow concurrent readers.
    """

    def __init__(self, db_path: str = ":memory:") -> None:
        """Configure the store with a database path but do not open it yet."""
        self._db_path = db_path
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None

    def initialize(self) -> None:
        """Open the database connection and create the schema."""
        if self._db_path != ":memory:":
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)

        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        if self._db_path != ":memory:":
            self._conn.execute("PRAGMA journal_mode=WAL")
        existing_columns = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(export_jobs)").fetchall()
        }
        required_columns = {
            "id",
            "status",
            "dataset_id",
            "format",
            "created_at",
            "updated_at",
            "file_path",
            "download_url",
            "row_count",
            "size_bytes",
            "completed_at",
            "error_message",
        }
        if existing_columns and existing_columns != required_columns:
            self._conn.execute("DROP TABLE export_jobs")
        self._conn.execute(_CREATE_TABLE_SQL)
        self._conn.commit()

    def close(self) -> None:
        """Close the SQLite connection if it has been opened."""
        if self._conn:
            self._conn.close()
            self._conn = None

    def _row_to_job(self, row: sqlite3.Row) -> ExportJob:
        """Convert a sqlite3.Row into an ExportJob dataclass."""
        return ExportJob(**dict(row))

    def create(self, job_id: str, dataset_id: str, fmt: str = "parquet") -> ExportJob:
        """Insert a new pending export job."""
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT INTO export_jobs (id, status, dataset_id, format, created_at, updated_at) "
                "VALUES (?, 'pending', ?, ?, ?, ?)",
                (job_id, dataset_id, fmt, now, now),
            )
            self._conn.commit()
        return ExportJob(
            id=job_id, status="pending", dataset_id=dataset_id, format=fmt,
            created_at=now, updated_at=now,
        )

    def create_if_capacity(
        self,
        job_id: str,
        dataset_id: str,
        *,
        fmt: str = "parquet",
        max_concurrent: int,
    ) -> ExportJob | None:
        """Atomically create a pending job when active jobs are below capacity.

        Returns the created job or None if the concurrency limit has been reached.
        """
        now = time.time()
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                cur = self._conn.execute(
                    "SELECT COUNT(*) FROM export_jobs WHERE status IN ('pending', 'processing')",
                )
                active = int(cur.fetchone()[0])
                if active >= max_concurrent:
                    self._conn.rollback()
                    return None

                self._conn.execute(
                    "INSERT INTO export_jobs (id, status, dataset_id, format, created_at, updated_at) "
                    "VALUES (?, 'pending', ?, ?, ?, ?)",
                    (job_id, dataset_id, fmt, now, now),
                )
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise

        return ExportJob(
            id=job_id,
            status="pending",
            dataset_id=dataset_id,
            format=fmt,
            created_at=now,
            updated_at=now,
        )

    def claim_pending(self, job_id: str) -> bool:
        """Claim a pending job for processing; returns False if already claimed."""
        now = time.time()
        with self._lock:
            cur = self._conn.execute(
                "UPDATE export_jobs "
                "SET status = 'processing', updated_at = ? "
                "WHERE id = ? AND status = 'pending'",
                (now, job_id),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def get(self, job_id: str) -> ExportJob | None:
        """Fetch a single job by ID, or None if not found."""
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM export_jobs WHERE id = ?", (job_id,),
            )
            row = cur.fetchone()
        return self._row_to_job(row) if row else None

    def update_status(
        self,
        job_id: str,
        status: str,
        *,
        file_path: str | None = None,
        download_url: str | None = None,
        row_count: int | None = None,
        size_bytes: int | None = None,
        completed_at: float | None = None,
        error_message: str | None = None,
    ) -> ExportJob | None:
        """Transition a job to a new status with optional metadata updates.

        Returns the updated job, or None if the job doesn't exist.
        Raises ValueError on invalid status transitions.
        """
        if status not in VALID_STATUSES:
            raise ValueError(f"Invalid status: {status}")

        with self._lock:
            cur = self._conn.execute(
                "SELECT status FROM export_jobs WHERE id = ?", (job_id,),
            )
            row = cur.fetchone()
            if row is None:
                return None

            current = row["status"]
            if status not in _VALID_TRANSITIONS.get(current, set()):
                raise ValueError(
                    f"Invalid transition: {current} -> {status} for job {job_id}"
                )

            now = time.time()
            sets = ["status = ?", "updated_at = ?"]
            params: list = [status, now]
            if file_path is not None:
                sets.append("file_path = ?")
                params.append(file_path)
            if download_url is not None:
                sets.append("download_url = ?")
                params.append(download_url)
            if row_count is not None:
                sets.append("row_count = ?")
                params.append(row_count)
            if size_bytes is not None:
                sets.append("size_bytes = ?")
                params.append(size_bytes)
            if completed_at is None and status == "complete":
                completed_at = now
            if completed_at is not None:
                sets.append("completed_at = ?")
                params.append(completed_at)
            if error_message is not None:
                sets.append("error_message = ?")
                params.append(error_message)

            params.append(job_id)
            self._conn.execute(
                f"UPDATE export_jobs SET {', '.join(sets)} WHERE id = ?",
                params,
            )
            self._conn.commit()

        return self.get(job_id)

    def count_active(self) -> int:
        """Count jobs in pending or processing status."""
        with self._lock:
            cur = self._conn.execute(
                "SELECT COUNT(*) FROM export_jobs WHERE status IN ('pending', 'processing')",
            )
            return cur.fetchone()[0]

    def find_stale(self) -> list[ExportJob]:
        """Return jobs in pending or processing state (presumed stale after restart)."""
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM export_jobs WHERE status IN ('pending', 'processing')",
            )
            return [self._row_to_job(row) for row in cur.fetchall()]

    def find_expired(self, ttl_seconds: int) -> list[ExportJob]:
        """Find jobs older than TTL that haven't been expired yet."""
        cutoff = time.time() - ttl_seconds
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM export_jobs "
                "WHERE created_at < ? AND status IN ('complete', 'failed')",
                (cutoff,),
            )
            return [self._row_to_job(row) for row in cur.fetchall()]

    def delete(self, job_id: str) -> bool:
        """Delete a job record. Returns True if a row was deleted."""
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM export_jobs WHERE id = ?", (job_id,),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def list(
        self,
        *,
        limit: int,
        status: str | None = None,
        before_created_at: float | None = None,
        before_id: str | None = None,
    ) -> list[ExportJob]:
        """Return jobs ordered newest-first with optional cursor and status filter."""
        clauses: list[str] = []
        params: list[object] = []

        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if before_created_at is not None and before_id is not None:
            clauses.append("(created_at < ? OR (created_at = ? AND id < ?))")
            params.extend([before_created_at, before_created_at, before_id])

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        query = (
            "SELECT * FROM export_jobs "
            f"{where_sql} "
            "ORDER BY created_at DESC, id DESC "
            "LIMIT ?"
        )
        params.append(limit)

        with self._lock:
            cur = self._conn.execute(query, params)
            return [self._row_to_job(row) for row in cur.fetchall()]
