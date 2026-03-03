"""
Export service: coordinates job store, query execution, and file management.

Provides the business logic boundary between API routes and the durable
export job store. All export operations go through this service.
"""

import logging
import uuid
from pathlib import Path

from server import datasets
from server.config import get_settings
from server.engine import db_manager, is_missing_table_error
from server.errors import (
    DatasetUnavailableError,
    ExportFileNotFoundError,
    ExportNotFoundError,
    ExportNotReadyError,
    TooManyConcurrentExportsError,
)
from server.export_store import ExportJob, ExportJobStore
from server.models import ExportRequest
from server.query_builder import build_export_sql

logger = logging.getLogger("query_service.export")


def _escape_sql_string(value: str) -> str:
    """Escape single quotes for SQL string literals."""
    return value.replace("'", "''")


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
        job_id = "exp-" + str(uuid.uuid4())[:8]
        job = self._store.create_if_capacity(
            job_id,
            body.dataset_id,
            max_concurrent=settings.export_max_concurrent,
        )
        if job is None:
            raise TooManyConcurrentExportsError(settings.export_max_concurrent)
        return job

    def process(self, job_id: str, body: ExportRequest) -> None:
        """Execute the export query and write the CSV file.

        Intended to run in a background thread. Updates job status to
        'processing' then 'complete' or 'failed'.
        """
        try:
            if not self._store.claim_pending(job_id):
                logger.info(
                    "Skipped export processing; job was already claimed or no longer pending",
                    extra={"export_id": job_id},
                )
                return
            settings = get_settings()
            output_dir = Path(settings.export_output_dir)
            output_dir.mkdir(parents=True, exist_ok=True)
            fmt = body.query.format.lower()
            file_ext = "parquet" if fmt == "parquet" else "csv"
            file_path = output_dir / f"{job_id}.{file_ext}"

            schema_fields = datasets.get_schema_field_names(body.dataset_id)
            sql, params, _headers = build_export_sql(
                body.dataset_id, body.query, body.date_range, schema_fields,
            )
            query_params = tuple(params) if params else None

            count_sql = f"SELECT COUNT(*) FROM ({sql}) AS export_rows"
            count_rows = db_manager.execute_sql(
                count_sql,
                query_params,
                dataset_id=body.dataset_id,
            )
            row_count = int(count_rows[0][0]) if count_rows else 0

            escaped_path = _escape_sql_string(str(file_path))
            if fmt == "parquet":
                copy_sql = f"COPY ({sql}) TO '{escaped_path}' (FORMAT PARQUET)"
            else:
                copy_sql = f"COPY ({sql}) TO '{escaped_path}' (FORMAT CSV, HEADER TRUE)"
            with db_manager.cursor() as cur:
                try:
                    if query_params:
                        cur.execute(copy_sql, query_params)
                    else:
                        cur.execute(copy_sql)
                except Exception as exc:
                    if is_missing_table_error(exc):
                        raise DatasetUnavailableError(body.dataset_id) from exc
                    raise

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
        except DatasetUnavailableError as exc:
            self._store.update_status(
                job_id,
                "failed",
                error_message=f"{exc.code}: {exc.message} ({body.dataset_id})",
            )
            logger.warning(
                "Export failed due to unavailable dataset",
                extra={"export_id": job_id, "dataset_id": body.dataset_id, "error_code": exc.code},
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
        """Mark any active jobs as failed on startup (stale from crash/restart)."""
        stale: list[ExportJob] = []
        with self._store._lock:
            cur = self._store._conn.execute(
                "SELECT * FROM export_jobs WHERE status IN ('pending', 'processing')",
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


_export_service: ExportService | None = None


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
