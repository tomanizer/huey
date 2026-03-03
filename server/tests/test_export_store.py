"""
Unit tests for the SQLite-backed ExportJobStore.
"""

import time

import pytest

from server.export_store import ExportJobStore


@pytest.fixture
def store() -> ExportJobStore:
    s = ExportJobStore(":memory:")
    s.initialize()
    yield s
    s.close()


class TestCreate:
    def test_creates_pending_job(self, store: ExportJobStore) -> None:
        job = store.create("exp-1", "ds1")
        assert job.id == "exp-1"
        assert job.status == "pending"
        assert job.dataset_id == "ds1"
        assert job.created_at > 0
        assert job.file_path is None

    def test_duplicate_id_raises(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        with pytest.raises(Exception):
            store.create("exp-1", "ds2")


class TestGet:
    def test_returns_job(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        job = store.get("exp-1")
        assert job is not None
        assert job.id == "exp-1"

    def test_returns_none_for_missing(self, store: ExportJobStore) -> None:
        assert store.get("nonexistent") is None


class TestUpdateStatus:
    def test_valid_transition(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        job = store.update_status("exp-1", "processing")
        assert job.status == "processing"

    def test_transition_to_complete_with_metadata(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        store.update_status("exp-1", "processing")
        job = store.update_status(
            "exp-1", "complete",
            file_path="/tmp/exp-1.csv",
            download_url="/export/exp-1/download",
            row_count=42,
        )
        assert job.status == "complete"
        assert job.file_path == "/tmp/exp-1.csv"
        assert job.download_url == "/export/exp-1/download"
        assert job.row_count == 42

    def test_transition_to_failed_with_error(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        store.update_status("exp-1", "processing")
        job = store.update_status("exp-1", "failed", error_message="boom")
        assert job.status == "failed"
        assert job.error_message == "boom"

    def test_invalid_transition_raises(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        with pytest.raises(ValueError, match="Invalid transition"):
            store.update_status("exp-1", "complete")

    def test_invalid_status_raises(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        with pytest.raises(ValueError, match="Invalid status"):
            store.update_status("exp-1", "bogus")

    def test_missing_job_returns_none(self, store: ExportJobStore) -> None:
        assert store.update_status("nonexistent", "processing") is None

    def test_updated_at_changes(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        before = store.get("exp-1").updated_at
        time.sleep(0.01)
        store.update_status("exp-1", "processing")
        after = store.get("exp-1").updated_at
        assert after > before


class TestCountActive:
    def test_counts_pending_and_processing(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        store.create("exp-2", "ds1")
        store.update_status("exp-2", "processing")
        store.create("exp-3", "ds1")
        store.update_status("exp-3", "processing")
        store.update_status("exp-3", "complete", file_path="/tmp/f.csv")
        assert store.count_active() == 2  # exp-1 pending, exp-2 processing

    def test_zero_when_empty(self, store: ExportJobStore) -> None:
        assert store.count_active() == 0


class TestFindExpired:
    def test_finds_old_jobs(self, store: ExportJobStore) -> None:
        store.create("exp-old", "ds1")
        with store._lock:
            store._conn.execute(
                "UPDATE export_jobs SET created_at = ? WHERE id = ?",
                (time.time() - 7200, "exp-old"),
            )
            store._conn.commit()
        store.create("exp-new", "ds1")

        expired = store.find_expired(3600)
        ids = [j.id for j in expired]
        assert "exp-old" in ids
        assert "exp-new" not in ids

    def test_excludes_already_expired(self, store: ExportJobStore) -> None:
        store.create("exp-old", "ds1")
        store.update_status("exp-old", "processing")
        store.update_status("exp-old", "expired")
        with store._lock:
            store._conn.execute(
                "UPDATE export_jobs SET created_at = ? WHERE id = ?",
                (time.time() - 7200, "exp-old"),
            )
            store._conn.commit()

        expired = store.find_expired(3600)
        assert len(expired) == 0


class TestDelete:
    def test_deletes_existing(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        assert store.delete("exp-1") is True
        assert store.get("exp-1") is None

    def test_missing_returns_false(self, store: ExportJobStore) -> None:
        assert store.delete("nonexistent") is False


class TestPersistence:
    def test_survives_close_and_reopen(self, tmp_path) -> None:
        db_path = str(tmp_path / "test.db")
        store1 = ExportJobStore(db_path)
        store1.initialize()
        store1.create("exp-1", "ds1")
        store1.close()

        store2 = ExportJobStore(db_path)
        store2.initialize()
        job = store2.get("exp-1")
        assert job is not None
        assert job.id == "exp-1"
        assert job.status == "pending"
        store2.close()
