"""Tests for SQLite L2 cache store."""

import time

from server.cache_store_sqlite import SQLiteCacheEntry, SQLiteCacheStore


def test_sqlite_round_trip(tmp_path) -> None:
    store = SQLiteCacheStore(str(tmp_path / "cache.db"), max_bytes=1024 * 1024)
    store.initialize()
    store.set("k1", b"value", ttl_seconds=1.0, size_bytes=5)
    entry = store.get("k1")
    assert isinstance(entry, SQLiteCacheEntry)
    assert entry.value_blob == b"value"
    store.close()


def test_sqlite_expiry(tmp_path) -> None:
    store = SQLiteCacheStore(str(tmp_path / "cache-expire.db"), max_bytes=1024 * 1024)
    store.initialize()
    store.set("k1", b"value", ttl_seconds=0.05, size_bytes=5)
    time.sleep(0.06)
    assert store.get("k1") is None
    store.close()


def test_sqlite_prune_and_eviction(tmp_path) -> None:
    store = SQLiteCacheStore(str(tmp_path / "cache-evict.db"), max_bytes=5)
    store.initialize()
    store.set("a", b"111", ttl_seconds=1.0, size_bytes=3)
    store.set("b", b"222", ttl_seconds=1.0, size_bytes=3)
    # Oldest entry should be evicted to satisfy max_bytes
    assert store.get("a") is None
    assert store.get("b") is not None
    removed = store.prune_expired()
    assert removed >= 0
    store.close()


def test_sqlite_stats_hits_and_misses(tmp_path) -> None:
    store = SQLiteCacheStore(str(tmp_path / "cache-stats.db"), max_bytes=1024 * 1024)
    store.initialize()
    store.set("k1", b"value", ttl_seconds=1.0, size_bytes=5)

    store.get("k1")   # hit
    store.get("k1")   # hit
    store.get("k2")   # miss

    stats = store.stats()
    assert stats["l2_hits"] == 2
    assert stats["l2_misses"] == 1
    assert stats["l2_evictions"] == 0
    assert stats["l2_prune_count"] == 0
    store.close()


def test_sqlite_stats_evictions(tmp_path) -> None:
    store = SQLiteCacheStore(str(tmp_path / "cache-ev-stats.db"), max_bytes=5)
    store.initialize()
    store.set("a", b"111", ttl_seconds=1.0, size_bytes=3)
    store.set("b", b"222", ttl_seconds=1.0, size_bytes=3)  # triggers eviction of "a"

    stats = store.stats()
    assert stats["l2_evictions"] >= 1
    store.close()


def test_sqlite_stats_prune_count(tmp_path) -> None:
    store = SQLiteCacheStore(str(tmp_path / "cache-prune-stats.db"), max_bytes=1024 * 1024)
    store.initialize()
    store.set("k1", b"v1", ttl_seconds=0.05, size_bytes=2)
    store.set("k2", b"v2", ttl_seconds=0.05, size_bytes=2)
    time.sleep(0.06)
    removed = store.prune_expired()
    assert removed == 2

    stats = store.stats()
    assert stats["l2_prune_count"] == 2
    store.close()


def test_sqlite_stats_reset_on_reset(tmp_path) -> None:
    store = SQLiteCacheStore(str(tmp_path / "cache-reset-stats.db"), max_bytes=1024 * 1024)
    store.initialize()
    store.set("k1", b"v1", ttl_seconds=1.0, size_bytes=2)
    store.get("k1")
    store.get("missing")

    store.reset()
    stats = store.stats()
    assert stats["l2_hits"] == 0
    assert stats["l2_misses"] == 0
    store.close()

