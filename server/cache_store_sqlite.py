"""SQLite-backed cache store used as optional L2 persistence."""

from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class SQLiteCacheEntry:
    """Row returned from SQLite cache."""

    value_blob: bytes
    size_bytes: int
    expires_at: float


class SQLiteCacheStore:
    """Simple key/value cache persisted in SQLite."""

    def __init__(self, path: str, max_bytes: int) -> None:
        self.path = path
        self.max_bytes = max_bytes
        self._lock = threading.RLock()
        self._conn: sqlite3.Connection | None = None
        self._stats = {"l2_hits": 0, "l2_misses": 0, "l2_evictions": 0, "l2_prune_count": 0}

    def initialize(self) -> None:
        """Initialize database and schema."""
        db_path = Path(self.path)
        if db_path.parent:
            db_path.parent.mkdir(parents=True, exist_ok=True)

        self._conn = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA synchronous=NORMAL;")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cache_entries (
                cache_key TEXT PRIMARY KEY,
                value_blob BLOB NOT NULL,
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                size_bytes INTEGER NOT NULL,
                last_access REAL NOT NULL
            )
            """
        )
        self._conn.commit()

    def close(self) -> None:
        """Close open connection (if any)."""
        with self._lock:
            if self._conn:
                self._conn.close()
                self._conn = None

    def stats(self) -> dict[str, int]:
        """Return a copy of L2 cache statistics."""
        with self._lock:
            return dict(self._stats)

    def reset(self) -> None:
        """Drop all cache rows and reset counters (used in tests)."""
        with self._lock:
            if not self._conn:
                return
            self._conn.execute("DELETE FROM cache_entries")
            self._conn.commit()
            self._stats = {"l2_hits": 0, "l2_misses": 0, "l2_evictions": 0, "l2_prune_count": 0}

    def _execute(self, sql: str, params: tuple[Any, ...]) -> sqlite3.Cursor:
        if not self._conn:
            raise RuntimeError("Cache store not initialized")
        return self._conn.execute(sql, params)

    def _now(self) -> float:
        return time.time()

    def get(self, cache_key: str) -> SQLiteCacheEntry | None:
        """Return cached value if not expired, updating last_access."""
        with self._lock:
            cur = self._execute(
                "SELECT value_blob, expires_at, size_bytes FROM cache_entries WHERE cache_key=?",
                (cache_key,),
            )
            row = cur.fetchone()
            if not row:
                self._stats["l2_misses"] += 1
                return None
            value_blob, expires_at, size_bytes = row
            if expires_at <= self._now():
                self._execute("DELETE FROM cache_entries WHERE cache_key=?", (cache_key,))
                if self._conn:
                    self._conn.commit()
                self._stats["l2_misses"] += 1
                return None
            self._execute(
                "UPDATE cache_entries SET last_access=? WHERE cache_key=?",
                (self._now(), cache_key),
            )
            if self._conn:
                self._conn.commit()
            self._stats["l2_hits"] += 1
            return SQLiteCacheEntry(value_blob=value_blob, size_bytes=size_bytes, expires_at=expires_at)

    def set(self, cache_key: str, value_blob: bytes, ttl_seconds: float, size_bytes: int) -> None:
        """Insert or replace a row."""
        expires_at = self._now() + ttl_seconds
        now = self._now()
        with self._lock:
            self._execute(
                """
                INSERT OR REPLACE INTO cache_entries(cache_key, value_blob, created_at, expires_at, size_bytes, last_access)
                VALUES(?, ?, ?, ?, ?, ?)
                """,
                (cache_key, value_blob, now, expires_at, size_bytes, now),
            )
            self._conn and self._conn.commit()
            self._enforce_max_bytes_locked()

    def prune_expired(self) -> int:
        """Delete expired rows, returning count removed."""
        with self._lock:
            cur = self._execute("DELETE FROM cache_entries WHERE expires_at <= ?", (self._now(),))
            self._conn and self._conn.commit()
            removed = cur.rowcount or 0
            self._stats["l2_prune_count"] += removed
            return removed

    def _total_size_locked(self) -> int:
        cur = self._execute("SELECT COALESCE(SUM(size_bytes), 0) FROM cache_entries", ())
        row = cur.fetchone()
        return int(row[0]) if row and row[0] is not None else 0

    def _enforce_max_bytes_locked(self) -> None:
        if self.max_bytes <= 0:
            return
        total = self._total_size_locked()
        if total <= self.max_bytes:
            return
        # Evict least-recently-used (by last_access) rows until within budget.
        while total > self.max_bytes:
            cur = self._execute(
                "SELECT cache_key, size_bytes FROM cache_entries ORDER BY last_access ASC LIMIT 1",
                (),
            )
            row = cur.fetchone()
            if not row:
                break
            cache_key, size_bytes = row
            self._execute("DELETE FROM cache_entries WHERE cache_key=?", (cache_key,))
            total -= int(size_bytes or 0)
            self._stats["l2_evictions"] += 1
        self._conn and self._conn.commit()
