"""
Export service: coordinates job store, query execution, and file management.

Provides the business logic boundary between API routes and the durable
export job store. All export operations go through this service.
"""

import logging
import sqlite3
import uuid
from base64 import urlsafe_b64decode, urlsafe_b64encode
import csv
import json
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


def _quote_identifier(value: str) -> str:
    """Safely quote SQL identifiers."""
    return '"' + value.replace('"', '""') + '"'


def _infer_sqlite_type(rows: list[tuple], column_index: int) -> str:
    """Infer a SQLite column affinity from result rows."""
    for row in rows:
        value = row[column_index]
        if value is None:
            continue
        if isinstance(value, bool | int):
            return "INTEGER"
        if isinstance(value, float):
            return "REAL"
        if isinstance(value, bytes | bytearray | memoryview):
            return "BLOB"
        return "TEXT"
    return "TEXT"


def _export_sqlite_file(file_path: Path, sql: str, query_params: tuple | None) -> None:
    """Export query results into a SQLite database file with one table."""
    with db_manager.cursor() as cur:
        if query_params:
            cur.execute(sql, query_params)
        else:
            cur.execute(sql)
        rows = cur.fetchall()
        columns = [column[0] for column in (cur.description or [])]

    with sqlite3.connect(file_path) as sqlite_conn:
        quoted_columns = ", ".join(
            f"{_quote_identifier(column)} {_infer_sqlite_type(rows, index)}"
            for index, column in enumerate(columns)
        )
        sqlite_conn.execute(f"CREATE TABLE export_result ({quoted_columns})")
        if rows:
            placeholders = ", ".join(["?"] * len(columns))
            sqlite_conn.executemany(f"INSERT INTO export_result VALUES ({placeholders})", rows)
        sqlite_conn.commit()


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
            fmt=body.query.format,
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
            file_ext = "csv" if fmt == "csv_with_bom" else fmt
            file_path = output_dir / f"{job_id}.{file_ext}"

            schema_fields = datasets.get_schema_field_names(body.dataset_id)
            sql, params, _headers = build_export_sql(
                body.dataset_id, body.query, body.date_range, schema_fields,
            )
            query_params = tuple(params) if params else None

            row_count = None

            escaped_path = _escape_sql_string(str(file_path))
            try:
                if fmt == "parquet":
                    copy_sql = f"COPY ({sql}) TO '{escaped_path}' (FORMAT PARQUET)"
                    with db_manager.cursor() as cur:
                        if query_params:
                            cur.execute(copy_sql, query_params)
                        else:
                            cur.execute(copy_sql)
                elif fmt == "csv":
                    copy_sql = f"COPY ({sql}) TO '{escaped_path}' (FORMAT CSV, HEADER TRUE)"
                    with db_manager.cursor() as cur:
                        if query_params:
                            cur.execute(copy_sql, query_params)
                        else:
                            cur.execute(copy_sql)
                elif fmt == "csv_with_bom":
                    with db_manager.cursor() as cur:
                        if query_params:
                            cur.execute(sql, query_params)
                        else:
                            cur.execute(sql)
                        rows = cur.fetchall()
                        headers = [column[0] for column in (cur.description or [])]
                    with file_path.open("w", encoding="utf-8-sig", newline="") as csv_file:
                        writer = csv.writer(csv_file)
                        writer.writerow(headers)
                        writer.writerows(rows)
                    row_count = len(rows)
                elif fmt == "ndjson":
                    with db_manager.cursor() as cur:
                        if query_params:
                            cur.execute(sql, query_params)
                        else:
                            cur.execute(sql)
                        rows = cur.fetchall()
                        headers = [column[0] for column in (cur.description or [])]
                    with file_path.open("w", encoding="utf-8") as ndjson_file:
                        for row in rows:
                            record = {
                                header: value
                                for header, value in zip(headers, row, strict=False)
                            }
                            ndjson_file.write(json.dumps(record, default=str, ensure_ascii=False))
                            ndjson_file.write("\n")
                    row_count = len(rows)
                elif fmt == "duckdb":
                    quoted_db_alias = _quote_identifier("export_db")
                    with db_manager.cursor() as cur:
                        cur.execute(f"ATTACH '{escaped_path}' AS {quoted_db_alias}")
                        try:
                            create_sql = (
                                f"CREATE TABLE {quoted_db_alias}.main.export_result "
                                f"AS SELECT * FROM ({sql}) AS export_result"
                            )
                            if query_params:
                                cur.execute(create_sql, query_params)
                            else:
                                cur.execute(create_sql)
                        finally:
                            cur.execute(f"DETACH {quoted_db_alias}")
                elif fmt == "sqlite":
                    _export_sqlite_file(file_path, sql, query_params)
            except Exception as exc:
                if is_missing_table_error(exc):
                    raise DatasetUnavailableError(body.dataset_id) from exc
                raise

            current_job = self._store.get(job_id)
            if current_job is None or current_job.status == "cancelled":
                file_path.unlink(missing_ok=True)
                logger.info("Cancelled export discarded", extra={"export_id": job_id})
                return

            size_bytes = file_path.stat().st_size if file_path.exists() else None
            self._store.update_status(
                job_id, "complete",
                file_path=str(file_path),
                download_url=f"/api/v1/exports/{job_id}/file",
                row_count=row_count,
                size_bytes=size_bytes,
            )
            logger.info(
                "Export complete",
                extra={"export_id": job_id, "row_count": row_count, "size_bytes": size_bytes},
            )
        except DatasetUnavailableError as exc:
            current_job = self._store.get(job_id)
            if current_job is None or current_job.status == "cancelled":
                return
            self._store.update_status(job_id, "failed", error_message=f"{exc.code}: {exc.message} ({body.dataset_id})")
            logger.warning(
                "Export failed due to unavailable dataset",
                extra={"export_id": job_id, "dataset_id": body.dataset_id, "error_code": exc.code},
            )
        except Exception:
            current_job = self._store.get(job_id)
            if current_job is None or current_job.status == "cancelled":
                return
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

    def list_exports(
        self,
        *,
        limit: int = 20,
        cursor: str | None = None,
        status: str | None = None,
    ) -> tuple[list[ExportJob], str | None]:
        """Return newest-first export jobs with cursor pagination."""
        before_created_at = None
        before_id = None
        if cursor:
            payload = json.loads(urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8"))
            before_created_at = float(payload["created_at"])
            before_id = str(payload["id"])

        jobs = self._store.list(
            limit=limit + 1,
            status=status,
            before_created_at=before_created_at,
            before_id=before_id,
        )
        next_cursor = None
        if len(jobs) > limit:
            last = jobs[limit - 1]
            next_cursor = urlsafe_b64encode(
                json.dumps({"created_at": last.created_at, "id": last.id}).encode("utf-8")
            ).decode("ascii")
            jobs = jobs[:limit]
        return jobs, next_cursor

    def delete_export(self, job_id: str) -> None:
        """Cancel or delete an export job depending on its current state."""
        job = self.get_status(job_id)
        if job.status in {"pending", "processing"}:
            self._store.update_status(job_id, "cancelled")
            if job.file_path:
                Path(job.file_path).unlink(missing_ok=True)
            return

        if job.file_path:
            Path(job.file_path).unlink(missing_ok=True)
        self._store.delete(job_id)

    def recover_stale_jobs(self) -> int:
        """Mark any active jobs as failed on startup (stale from crash/restart)."""
        stale = self._store.find_stale()
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
