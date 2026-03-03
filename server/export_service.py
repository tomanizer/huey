"""
Export service: coordinates job store, query execution, and file management.

Provides the business logic boundary between API routes and the durable
export job store. All export operations go through this service.
"""

import csv
import logging
import uuid
from pathlib import Path
from typing import Optional

from server import datasets
from server.config import get_settings
from server.engine import db_manager
from server.errors import (
    ExportFileNotFoundError,
    ExportNotFoundError,
    ExportNotReadyError,
    TooManyConcurrentExportsError,
)
from server.export_store import ExportJob, ExportJobStore
from server.models import ExportRequest
from server.query_builder import build_export_sql

logger = logging.getLogger("query_service.export")


class ExportService:
    """Orchestrates export job lifecycle: submit, process, poll, download, cleanup."""

    def __init__(self, store: ExportJobStore) -> None:
        """Bind the service to a durable ExportJobStore implementation."""
        self._store = store

    @property
    def store(self) -> ExportJobStore:
        """Return the underlying ExportJobStore (primarily for tests)."""
        return self._store

    def submit(self, body: ExportRequest) -> ExportJob:
        """Create a new export job after enforcing concurrency limits.

        Runs TTL cleanup first, then checks the concurrency cap.
        Returns the newly created pending job.
        """
        self.cleanup_expired()

        settings = get_settings()
        if self._store.count_active() >= settings.export_max_concurrent:
            raise TooManyConcurrentExportsError(settings.export_max_concurrent)

        job_id = "exp-" + str(uuid.uuid4())[:8]
        return self._store.create(job_id, body.dataset_id)

    def process(self, job_id: str, body: ExportRequest) -> None:
        """Execute the export query and write the CSV file.

        Intended to run in a background thread. Updates job status to
        'processing' then 'complete' or 'failed'.
        """
        try:
            self._store.update_status(job_id, "processing")
            settings = get_settings()
            output_dir = Path(settings.export_output_dir)
            output_dir.mkdir(parents=True, exist_ok=True)
            file_path = output_dir / f"{job_id}.csv"

            schema_fields = datasets.get_schema_field_names(body.dataset_id)
            sql, params, headers = build_export_sql(
                body.dataset_id, body.query, body.date_range, schema_fields,
            )

            rows = db_manager.execute_sql(sql, params)

            with open(file_path, "w", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(headers)
                for row in rows:
                    writer.writerow(row)

            row_count = len(rows) if rows else 0
            self._store.update_status(
                job_id, "complete",
                file_path=str(file_path),
                download_url=f"/export/{job_id}/download",
                row_count=row_count,
            )
            logger.info(
                "Export complete",
                extra={"export_id": job_id, "row_count": row_count},
            )
        except Exception:
            self._store.update_status(job_id, "failed", error_message="Export processing failed")
            logger.exception("Export failed", extra={"export_id": job_id})

    def get_status(self, job_id: str) -> ExportJob:
        """Retrieve a job's current status. Raises ExportNotFoundError if missing."""
        job = self._store.get(job_id)
        if job is None:
            raise ExportNotFoundError(job_id)
        return job

    def get_download_path(self, job_id: str) -> str:
        """Return the file path for a completed export. Raises on invalid state."""
        job = self.get_status(job_id)
        if job.status != "complete":
            raise ExportNotReadyError(job_id, job.status)
        if not job.file_path or not Path(job.file_path).exists():
            raise ExportFileNotFoundError(job_id)
        return job.file_path

    def cleanup_expired(self) -> int:
        """Expire old jobs and delete their CSV files. Returns count expired."""
        settings = get_settings()
        expired_jobs = self._store.find_expired(settings.export_ttl_seconds)
        count = 0
        for job in expired_jobs:
            if job.file_path:
                Path(job.file_path).unlink(missing_ok=True)
            self._store.update_status(job.id, "expired")
            logger.info("Expired export cleaned up", extra={"export_id": job.id})
            count += 1
        return count

    def recover_stale_jobs(self) -> int:
        """Mark any 'processing' jobs as 'failed' on startup (stale from crash)."""
        stale: list[ExportJob] = []
        with self._store._lock:
            cur = self._store._conn.execute(
                "SELECT * FROM export_jobs WHERE status = 'processing'",
            )
            stale = [self._store._row_to_job(row) for row in cur.fetchall()]

        count = 0
        for job in stale:
            self._store.update_status(
                job.id, "failed",
                error_message="Process restarted while job was running",
            )
            logger.warning(
                "Recovered stale export job",
                extra={"export_id": job.id},
            )
            count += 1
        return count


_export_service: Optional[ExportService] = None


def get_export_service() -> ExportService:
    """Return the singleton ExportService instance."""
    if _export_service is None:
        raise RuntimeError("ExportService not initialized — call init_export_service() first")
    return _export_service


def init_export_service(store: ExportJobStore) -> ExportService:
    """Initialize the global ExportService singleton."""
    global _export_service
    _export_service = ExportService(store)
    return _export_service
