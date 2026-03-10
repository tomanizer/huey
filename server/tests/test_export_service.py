"""
Unit tests for ExportService business logic.
"""

import time
from contextlib import nullcontext
from unittest.mock import patch

import pytest

from server.errors import (
    ExportFileNotFoundError,
    ExportNotFoundError,
    ExportNotReadyError,
    TooManyConcurrentExportsError,
)
from server.export_service import ExportService
from server.export_store import ExportJobStore
from server.models import ExportRequest


@pytest.fixture
def store() -> ExportJobStore:
    s = ExportJobStore(":memory:")
    s.initialize()
    yield s
    s.close()


@pytest.fixture
def service(store: ExportJobStore) -> ExportService:
    return ExportService(store)


def _export_request(dataset_id: str = "trades_v1") -> ExportRequest:
    return ExportRequest(
        dataset_id=dataset_id,
        date_range={"type": "single", "date": "2024-01-15"},
        query={"max_rows": 10},
    )


class TestSubmit:
    def test_creates_pending_job(self, service: ExportService) -> None:
        job = service.submit(_export_request())
        assert job.status == "pending"
        assert job.id.startswith("exp-")

    def test_enforces_concurrency_limit(self, service: ExportService, store: ExportJobStore) -> None:
        with patch("server.export_service.get_settings") as mock_settings:
            mock_settings.return_value.export_max_concurrent = 2
            mock_settings.return_value.export_ttl_seconds = 3600
            store.create("exp-a", "ds1")
            store.create("exp-b", "ds1")
            with pytest.raises(TooManyConcurrentExportsError):
                service.submit(_export_request())


class TestGetStatus:
    def test_returns_job(self, service: ExportService) -> None:
        job = service.submit(_export_request())
        fetched = service.get_status(job.id)
        assert fetched.id == job.id

    def test_raises_not_found(self, service: ExportService) -> None:
        with pytest.raises(ExportNotFoundError):
            service.get_status("nonexistent")


class TestProcess:
    def test_process_runs_single_copy_execution(self, service: ExportService, store: ExportJobStore, tmp_path) -> None:
        store.create("exp-test", "trades_v1")
        req = _export_request()
        req.query.format = "csv"

        with (
            patch("server.export_service.get_settings") as mock_settings,
            patch("server.export_service.datasets.get_schema_field_names", return_value=["date", "symbol"]),
            patch("server.export_service.build_export_sql", return_value=("SELECT * FROM trades_v1", [], [])),
            patch("server.export_service.db_manager.execute_sql") as mock_execute_sql,
            patch("server.export_service.db_manager.cursor") as mock_cursor,
        ):
            mock_settings.return_value.export_output_dir = str(tmp_path)
            mock_cur = mock_cursor.return_value.__enter__.return_value
            mock_cursor.return_value = nullcontext(mock_cur)

            service.process("exp-test", req)

        mock_execute_sql.assert_not_called()
        mock_cur.execute.assert_called_once()
        job = store.get("exp-test")
        assert job is not None
        assert job.status == "complete"
        assert job.row_count is None


class TestGetDownloadPath:
    def test_returns_path_for_complete_job(self, service: ExportService, store: ExportJobStore, tmp_path) -> None:
        job = service.submit(_export_request())
        store.update_status(job.id, "processing")
        csv_file = tmp_path / f"{job.id}.csv"
        csv_file.write_text("a,b\n1,2\n")
        store.update_status(
            job.id, "complete",
            file_path=str(csv_file),
            download_url=f"/api/v1/exports/{job.id}/download",
        )
        assert service.get_download_path(job.id) == str(csv_file)

    def test_raises_not_ready(self, service: ExportService) -> None:
        job = service.submit(_export_request())
        with pytest.raises(ExportNotReadyError):
            service.get_download_path(job.id)

    def test_raises_file_not_found(self, service: ExportService, store: ExportJobStore) -> None:
        job = service.submit(_export_request())
        store.update_status(job.id, "processing")
        store.update_status(
            job.id, "complete",
            file_path="/tmp/nonexistent.csv",
            download_url=f"/api/v1/exports/{job.id}/download",
        )
        with pytest.raises(ExportFileNotFoundError):
            service.get_download_path(job.id)


class TestCleanupExpired:
    def test_expires_old_jobs(self, service: ExportService, store: ExportJobStore, tmp_path) -> None:
        job = service.submit(_export_request())
        store.update_status(job.id, "processing")
        csv_file = tmp_path / f"{job.id}.csv"
        csv_file.write_text("data")
        store.update_status(
            job.id, "complete",
            file_path=str(csv_file),
        )
        with store._lock:
            store._conn.execute(
                "UPDATE export_jobs SET created_at = ? WHERE id = ?",
                (time.time() - 7200, job.id),
            )
            store._conn.commit()

        count = service.cleanup_expired()
        assert count == 1
        assert store.get(job.id).status == "expired"
        assert not csv_file.exists()


class TestRecoverStaleJobs:
    def test_marks_processing_as_failed(self, service: ExportService, store: ExportJobStore) -> None:
        job = service.submit(_export_request())
        store.update_status(job.id, "processing")

        recovered = service.recover_stale_jobs()
        assert recovered == 1
        assert store.get(job.id).status == "failed"
        assert "restarted" in store.get(job.id).error_message.lower()

    def test_marks_pending_as_failed(self, service: ExportService, store: ExportJobStore) -> None:
        job = service.submit(_export_request())
        recovered = service.recover_stale_jobs()
        assert recovered == 1
        assert store.get(job.id).status == "failed"

    def test_ignores_terminal_jobs(self, service: ExportService, store: ExportJobStore) -> None:
        service.submit(_export_request())
        job = service.submit(_export_request())
        store.update_status(job.id, "processing")
        store.update_status(job.id, "failed", error_message="boom")
        recovered = service.recover_stale_jobs()
        assert recovered == 1
