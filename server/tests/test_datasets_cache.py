"""Caching tests for dataset metadata."""

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from server import datasets

# Extra wait multiplier to ensure TTL expiry on slower clocks in CI.
TTL_EXPIRY_WAIT_MULTIPLIER = 2.5


@pytest.fixture(autouse=True)
def _reset_cache():
    datasets.reset_cache()
    yield
    datasets.reset_cache()


def _settings(path: Path | None, ttl: float = 60) -> object:
    return type(
        "MockSettings",
        (),
        {
            "datasets_config_path": str(path) if path else None,
            "schema_cache_ttl_seconds": ttl,
        },
    )()


def test_schema_cache_hit_and_miss(monkeypatch) -> None:
    calls = {"count": 0}

    def fake_load():
        calls["count"] += 1
        return {
            "datasets": [
                {"dataset_id": "cache_ds", "fields": [{"name": "id", "type": "string"}]}
            ]
        }

    monkeypatch.setattr(datasets, "load_datasets_config", fake_load)
    monkeypatch.setattr(datasets, "get_settings", lambda: _settings(None, ttl=1))
    datasets.reset_cache()

    first = datasets.get_schema("cache_ds")
    second = datasets.get_schema("cache_ds")

    assert first == second
    assert calls["count"] == 1
    stats = datasets.get_cache_stats()
    assert stats["cache_miss"] == 1
    assert stats["cache_hit"] == 1


def test_schema_cache_respects_ttl(monkeypatch) -> None:
    calls = {"count": 0}
    ttl = 0.05

    def fake_load():
        calls["count"] += 1
        return {
            "datasets": [
                {"dataset_id": "ttl_ds", "fields": [{"name": "id", "type": "string"}]}
            ]
        }

    monkeypatch.setattr(datasets, "load_datasets_config", fake_load)
    monkeypatch.setattr(datasets, "get_settings", lambda: _settings(None, ttl=ttl))
    datasets.reset_cache()

    datasets.get_schema("ttl_ds")
    time.sleep(ttl * TTL_EXPIRY_WAIT_MULTIPLIER)
    datasets.get_schema("ttl_ds")

    assert calls["count"] == 2
    stats = datasets.get_cache_stats()
    assert stats["refresh_count"] >= 1


def test_schema_cache_refreshes_on_config_change(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "datasets.yaml"
    config_path.write_text(
        """
datasets:
  - dataset_id: config_ds
    fields:
      - name: before
        type: string
"""
    )

    monkeypatch.setattr(datasets, "get_settings", lambda: _settings(config_path, ttl=1))
    datasets.reset_cache()

    initial = datasets.get_schema("config_ds")
    assert initial
    assert {f["name"] for f in initial["fields"]} == {"before"}

    config_path.write_text(
        """
datasets:
  - dataset_id: config_ds
    fields:
      - name: after
        type: string
"""
    )
    # Force an mtime bump to ensure config change detection even on coarse filesystems.
    os.utime(config_path, times=(config_path.stat().st_atime, time.time()))

    refreshed = datasets.get_schema("config_ds")
    assert refreshed
    assert {f["name"] for f in refreshed["fields"]} == {"after"}

    stats = datasets.get_cache_stats()
    assert stats["refresh_count"] >= 1


def test_partition_metadata_hooks(monkeypatch) -> None:
    monkeypatch.setattr(datasets, "get_settings", lambda: _settings(None, ttl=1))
    datasets.reset_cache()

    datasets.set_partition_metadata("ds", {"count": 2})
    assert datasets.get_partition_metadata("ds") == {"count": 2}

    datasets.clear_partition_metadata("ds")
    assert datasets.get_partition_metadata("ds") is None


def test_data_version_token_stable_with_reordered_metadata(monkeypatch) -> None:
    monkeypatch.setattr(datasets, "get_settings", lambda: _settings(None, ttl=1))
    datasets.reset_cache()
    datasets.set_partition_metadata(
        "ds",
        {
            "partitions": [
                {"date": "2026-03-01", "files": [{"path": "b.parquet", "size": 2, "etag": "e2"}]},
                {"date": "2026-03-01", "files": [{"path": "a.parquet", "size": 1, "etag": "e1"}]},
            ]
        },
    )
    token_a = datasets.get_data_version_token("ds", {"type": "single", "date": "2026-03-01"})

    datasets.set_partition_metadata(
        "ds",
        {
            "partitions": [
                {"date": "2026-03-01", "files": [{"etag": "e1", "size": 1, "path": "a.parquet"}]},
                {"date": "2026-03-01", "files": [{"etag": "e2", "size": 2, "path": "b.parquet"}]},
            ]
        },
    )
    token_b = datasets.get_data_version_token("ds", {"type": "single", "date": "2026-03-01"})
    assert token_a == token_b


def test_data_version_token_changes_on_partition_metadata_change(monkeypatch) -> None:
    monkeypatch.setattr(datasets, "get_settings", lambda: _settings(None, ttl=1))
    datasets.reset_cache()
    datasets.set_partition_metadata(
        "ds",
        {"partitions": [{"date": "2026-03-01", "files": [{"path": "a.parquet", "size": 1, "etag": "e1"}]}]},
    )
    token_a = datasets.get_data_version_token("ds", {"type": "single", "date": "2026-03-01"})

    datasets.set_partition_metadata(
        "ds",
        {"partitions": [{"date": "2026-03-01", "files": [{"path": "a.parquet", "size": 2, "etag": "e1"}]}]},
    )
    token_b = datasets.get_data_version_token("ds", {"type": "single", "date": "2026-03-01"})
    assert token_a != token_b


def test_data_version_token_ignores_non_intersecting_cobdate_updates(monkeypatch) -> None:
    monkeypatch.setattr(datasets, "get_settings", lambda: _settings(None, ttl=1))
    datasets.reset_cache()
    datasets.set_partition_metadata(
        "ds",
        {"partitions": [{"date": "2026-03-01", "files": [{"path": "a.parquet", "size": 1, "etag": "e1"}]}]},
    )
    token_before = datasets.get_data_version_token("ds", {"type": "single", "date": "2026-03-01"})

    # New COBDATE is published outside the requested date scope.
    datasets.set_partition_metadata(
        "ds",
        {
            "partitions": [
                {"date": "2026-03-01", "files": [{"path": "a.parquet", "size": 1, "etag": "e1"}]},
                {"date": "2026-03-02", "files": [{"path": "b.parquet", "size": 3, "etag": "e2"}]},
            ]
        },
    )
    token_after = datasets.get_data_version_token("ds", {"type": "single", "date": "2026-03-01"})
    assert token_before == token_after


def test_schema_cache_concurrent_reads_consistent(monkeypatch) -> None:
    calls = {"count": 0}

    def fake_load():
        calls["count"] += 1
        time.sleep(0.02)
        return {
            "datasets": [
                {"dataset_id": "concurrent_ds", "fields": [{"name": "id", "type": "string"}]}
            ]
        }

    monkeypatch.setattr(datasets, "load_datasets_config", fake_load)
    monkeypatch.setattr(datasets, "get_settings", lambda: _settings(None, ttl=1))
    datasets.reset_cache()

    start = threading.Barrier(8)

    def worker():
        start.wait()
        return datasets.get_schema("concurrent_ds")

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: worker(), range(8)))

    assert all(r == results[0] for r in results)
    assert results[0]["dataset_id"] == "concurrent_ds"
    stats = datasets.get_cache_stats()
    assert stats["cache_hit"] >= 1
    assert calls["count"] >= 1
