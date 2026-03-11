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
        job = store.create("exp-1", "ds1", "csv")
        assert job.id == "exp-1"
        assert job.status == "pending"
        assert job.dataset_id == "ds1"
        assert job.format == "csv"
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
            download_url="/api/v1/exports/exp-1/file",
            row_count=42,
            size_bytes=128,
        )
        assert job.status == "complete"
        assert job.file_path == "/tmp/exp-1.csv"
        assert job.download_url == "/api/v1/exports/exp-1/file"
        assert job.row_count == 42
        assert job.size_bytes == 128
        assert job.completed_at is not None

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


class TestAtomicCreateAndClaim:
    def test_create_if_capacity_creates_when_slot_available(self, store: ExportJobStore) -> None:
        job = store.create_if_capacity("exp-1", "ds1", fmt="ndjson", max_concurrent=1)
        assert job is not None
        assert job.status == "pending"
        assert job.format == "ndjson"

    def test_create_if_capacity_returns_none_when_full(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        job = store.create_if_capacity("exp-2", "ds1", max_concurrent=1)
        assert job is None

    def test_claim_pending_transitions_once(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        assert store.claim_pending("exp-1") is True
        assert store.claim_pending("exp-1") is False
        assert store.get("exp-1").status == "processing"


class TestFindExpired:
    def test_finds_old_jobs(self, store: ExportJobStore) -> None:
        store.create("exp-old", "ds1")
        store.update_status("exp-old", "processing")
        store.update_status("exp-old", "complete", file_path="/tmp/exp-old.csv")
        with store._lock:
            store._conn.execute(
                "UPDATE export_jobs SET created_at = ? WHERE id = ?",
                (time.time() - 7200, "exp-old"),
            )
            store._conn.commit()
        store.create("exp-new", "ds1")
        store.update_status("exp-new", "processing")

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

    def test_excludes_active_jobs(self, store: ExportJobStore) -> None:
        store.create("exp-active", "ds1")
        store.update_status("exp-active", "processing")
        with store._lock:
            store._conn.execute(
                "UPDATE export_jobs SET created_at = ? WHERE id = ?",
                (time.time() - 7200, "exp-active"),
            )
            store._conn.commit()
        expired = store.find_expired(3600)
        assert len(expired) == 0


class TestFindStale:
    def test_returns_pending_and_processing(self, store: ExportJobStore) -> None:
        store.create("exp-pending", "ds1")
        store.create("exp-proc", "ds1")
        store.update_status("exp-proc", "processing")
        store.create("exp-complete", "ds1")
        store.update_status("exp-complete", "processing")
        store.update_status("exp-complete", "complete", file_path="/tmp/f.csv")

        stale = store.find_stale()
        ids = {j.id for j in stale}
        assert ids == {"exp-pending", "exp-proc"}

    def test_empty_when_no_active(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        store.update_status("exp-1", "processing")
        store.update_status("exp-1", "complete", file_path="/tmp/f.csv")
        assert store.find_stale() == []


class TestDelete:
    def test_deletes_existing(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        assert store.delete("exp-1") is True
        assert store.get("exp-1") is None

    def test_missing_returns_false(self, store: ExportJobStore) -> None:
        assert store.delete("nonexistent") is False


class TestList:
    def test_lists_newest_first(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        time.sleep(0.01)
        store.create("exp-2", "ds1")

        jobs = store.list(limit=10)
        assert [job.id for job in jobs] == ["exp-2", "exp-1"]

    def test_filters_by_status_and_cursor(self, store: ExportJobStore) -> None:
        store.create("exp-1", "ds1")
        store.update_status("exp-1", "processing")
        store.update_status("exp-1", "complete", file_path="/tmp/f1.csv")
        time.sleep(0.01)
        store.create("exp-2", "ds1")
        store.update_status("exp-2", "processing")
        time.sleep(0.01)
        store.create("exp-3", "ds1")
        store.update_status("exp-3", "processing")
        store.update_status("exp-3", "cancelled")

        first_page = store.list(limit=1, status="processing")
        assert [job.id for job in first_page] == ["exp-2"]

        next_page = store.list(limit=10, before_created_at=first_page[0].created_at, before_id=first_page[0].id)
        assert "exp-1" in [job.id for job in next_page]


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
