"""Query result caching: weighted LRU (L1) with optional SQLite L2."""

from __future__ import annotations

import asyncio
import hashlib
import json
import pickle
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from server.cache_store_sqlite import SQLiteCacheEntry, SQLiteCacheStore
from server.config import get_settings


def _datasets_default_config_path() -> Path:
    """Return the default datasets config path (mirrors datasets._default_config_path)."""
    return Path(__file__).resolve().parent / "datasets_config" / "datasets.yaml"


def _config_identity() -> dict[str, Any]:
    """Return a stable token for the datasets config path + mtime."""
    settings = get_settings()
    cfg_path = getattr(settings, "datasets_config_path", None)
    path = Path(cfg_path) if cfg_path else _datasets_default_config_path()
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        mtime = None
    return {"path": str(path), "mtime": mtime}


def _canonicalize(obj: Any) -> Any:
    """Recursively canonicalize objects for deterministic JSON encoding."""
    if isinstance(obj, dict):
        return {k: _canonicalize(obj[k]) for k in sorted(obj)}
    if isinstance(obj, list):
        return [_canonicalize(v) for v in obj]
    if isinstance(obj, tuple):
        return [_canonicalize(v) for v in obj]
    if isinstance(obj, set):
        return sorted(_canonicalize(v) for v in obj)
    return obj


def canonical_json(obj: Any) -> str:
    """Return canonical JSON string with sorted keys and stable ordering."""
    normalized = _canonicalize(obj)
    return json.dumps(normalized, separators=(",", ":"), sort_keys=True, ensure_ascii=True)


def build_cache_key(
    endpoint: str,
    dataset_id: str,
    date_range: dict[str, Any] | None,
    query_payload: dict[str, Any],
    fact_version_token: Any | None = None,
    dim_version_token: Any | None = None,
    data_version_token: Any | None = None,
    data_token: Any | None = None,
    config_token: dict[str, Any] | None = None,
) -> str:
    """
    Build a deterministic cache key for a query.

    Includes endpoint, dataset, normalized date range/query, config token, and version tokens.

    ``fact_version_token`` and ``dim_version_token`` are the canonical token names.
    ``data_version_token`` and ``data_token`` are legacy aliases retained for
    backwards compatibility.
    """
    resolved_fact_token = fact_version_token if fact_version_token is not None else data_version_token
    resolved_dim_token = dim_version_token if dim_version_token is not None else data_token
    payload = {
        "endpoint": endpoint,
        "dataset_id": dataset_id,
        "date_range": _canonicalize(date_range),
        "query": _canonicalize(query_payload),
        "config_token": config_token or _config_identity(),
        "fact_version_token": resolved_fact_token,
        "dim_version_token": resolved_dim_token,
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


@dataclass
class _CacheEntry:
    value: Any
    size_bytes: int
    expires_at: float  # monotonic – fresh until this time
    stale_until: float = 0.0  # monotonic – serve stale until this time (0 = same as expires_at)


@dataclass
class CacheMetadata:
    cache_status: str  # "hit", "miss", "bypass"
    cache_source: str  # "l1", "l2", "compute", "inflight"
    is_stale: bool = False  # True when a stale entry was served and a background refresh was queued


class QueryResultCache:
    """Thread-safe weighted LRU + TTL cache with optional SQLite L2."""

    def __init__(
        self,
        max_bytes: int,
        max_item_bytes: int,
        default_ttl: float,
        admission_min_duration_ms: float = 0.0,
        store: SQLiteCacheStore | None = None,
    ) -> None:
        self.max_bytes = max_bytes
        self.max_item_bytes = max_item_bytes
        self.default_ttl = default_ttl
        self.admission_min_duration_ms = admission_min_duration_ms
        self.store = store
        self._entries: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._lock = asyncio.Lock()
        self._inflight_lock = asyncio.Lock()
        self._inflight: dict[str, asyncio.Future] = {}
        self._stats: dict[str, int] = {
            "hits": 0,
            "misses": 0,
            "evictions": 0,
            "current_bytes": 0,
            "entries": 0,
            "inflight": 0,
            "endpoint_tuples_hits": 0,
            "endpoint_tuples_misses": 0,
            "endpoint_cells_hits": 0,
            "endpoint_cells_misses": 0,
            "endpoint_picklist_hits": 0,
            "endpoint_picklist_misses": 0,
        }

    async def close(self) -> None:
        """Close L2 store if open."""
        if self.store:
            self.store.close()

    def stats(self) -> dict[str, int]:
        """Return a copy of cache statistics, including L2 stats when available."""
        result = dict(self._stats)
        if self.store:
            result.update(self.store.stats())
        return result

    def _record_hit(self) -> None:
        self._stats["hits"] += 1

    def _record_miss(self) -> None:
        self._stats["misses"] += 1

    def _now(self) -> float:
        return time.monotonic()

    def _serialize_value(self, value: Any) -> bytes:
        return pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)

    def _deserialize_value(self, blob: bytes) -> Any:
        return pickle.loads(blob)

    async def _evict_if_needed_locked(self) -> None:
        if self.max_bytes and self.max_bytes > 0:
            while self._stats["current_bytes"] > self.max_bytes and self._entries:
                key, entry = self._entries.popitem(last=False)
                self._stats["current_bytes"] -= entry.size_bytes
                self._stats["evictions"] += 1
        self._stats["entries"] = len(self._entries)

    async def _get_l1(self, cache_key: str) -> tuple[Any | None, bool]:
        """Return ``(value, is_stale)``.

        ``is_stale=True`` means the entry's fresh TTL has expired but it is
        still within the stale serving window.  Callers should trigger a
        background refresh.  Returns ``(None, False)`` when there is no usable
        entry (fully expired or absent).
        """
        async with self._lock:
            entry = self._entries.get(cache_key)
            if not entry:
                return None, False
            now = self._now()
            # Effective stale limit: use stale_until when it extends past expires_at,
            # otherwise treat expires_at as the hard expiry.
            stale_limit = entry.stale_until if entry.stale_until > entry.expires_at else entry.expires_at
            if stale_limit <= now:
                # Fully expired – evict and report as a miss.
                self._stats["current_bytes"] -= entry.size_bytes
                self._entries.pop(cache_key, None)
                self._stats["entries"] = len(self._entries)
                return None, False
            self._entries.move_to_end(cache_key)
            if entry.expires_at <= now:
                # Within the stale window – usable but stale.
                return entry.value, True
            # Fresh hit.
            return entry.value, False

    async def _store_l1(
        self, cache_key: str, value: Any, ttl_seconds: float, size_bytes: int, item_cap: int | None = None, stale_ttl_seconds: float = 0.0
    ) -> bool:
        cap = item_cap if item_cap is not None else self.max_item_bytes
        if cap and cap > 0 and size_bytes > cap:
            return False
        if self.max_bytes and self.max_bytes > 0 and size_bytes > self.max_bytes:
            return False
        expires_at = self._now() + ttl_seconds
        stale_until = expires_at + stale_ttl_seconds
        async with self._lock:
            existing = self._entries.pop(cache_key, None)
            if existing:
                self._stats["current_bytes"] -= existing.size_bytes
            self._entries[cache_key] = _CacheEntry(value=value, size_bytes=size_bytes, expires_at=expires_at, stale_until=stale_until)
            self._entries.move_to_end(cache_key)
            self._stats["current_bytes"] += size_bytes
            await self._evict_if_needed_locked()
            return True

    async def _get_l2(self, cache_key: str) -> tuple[Any | None, float]:
        if not self.store:
            return None, 0.0
        entry: SQLiteCacheEntry | None = self.store.get(cache_key)
        if not entry:
            return None, 0.0
        remaining = entry.expires_at - time.time()
        if remaining <= 0:
            return None, 0.0
        try:
            value = self._deserialize_value(entry.value_blob)
        except Exception:
            return None, 0.0
        return value, remaining

    async def _store_all(self, cache_key: str, value: Any, ttl_seconds: float, item_cap: int | None = None, stale_ttl_seconds: float = 0.0) -> bool:
        ttl = ttl_seconds if ttl_seconds is not None else self.default_ttl
        serialized = self._serialize_value(value)
        size_bytes = len(serialized)
        stored = await self._store_l1(cache_key, value, ttl, size_bytes, item_cap=item_cap, stale_ttl_seconds=stale_ttl_seconds)
        if stored and self.store:
            self.store.set(cache_key, serialized, ttl_seconds=ttl, size_bytes=size_bytes)
        return stored

    async def _refresh_in_background(
        self,
        cache_key: str,
        loader: Callable[[], Awaitable[Any]],
        ttl_seconds: float | None,
        max_item_bytes: int | None,
        stale_ttl_seconds: float,
    ) -> None:
        """Refresh a stale cache entry in the background (fire-and-forget).

        Uses the inflight map as a single-flight guard so only one background
        refresh runs per key at a time.
        """
        async with self._inflight_lock:
            if cache_key in self._inflight:
                return  # Another coroutine is already refreshing this key.
            future: asyncio.Future = asyncio.get_running_loop().create_future()
            self._inflight[cache_key] = future
            self._stats["inflight"] = len(self._inflight)

        try:
            result = await loader()
            ttl = ttl_seconds if ttl_seconds is not None else self.default_ttl
            item_cap = max_item_bytes if max_item_bytes is not None else self.max_item_bytes
            serialized_size = len(self._serialize_value(result))
            should_admit = True
            if item_cap and item_cap > 0 and serialized_size > item_cap:
                should_admit = False
            if ttl is not None and ttl <= 0:
                should_admit = False
            if should_admit:
                await self._store_all(cache_key, result, ttl, item_cap=item_cap, stale_ttl_seconds=stale_ttl_seconds)
            if not future.done():
                future.set_result(result)
        except Exception as exc:  # pragma: no cover - defensive
            if not future.done():
                future.set_exception(exc)
        finally:
            async with self._inflight_lock:
                self._inflight.pop(cache_key, None)
                self._stats["inflight"] = len(self._inflight)

    async def get_or_set(
        self,
        cache_key: str,
        loader: Callable[[], Awaitable[Any]],
        ttl_seconds: float | None = None,
        max_item_bytes: int | None = None,
        stale_ttl_seconds: float = 0.0,
        endpoint: str | None = None,
    ) -> tuple[Any, CacheMetadata]:
        """
        Return cached value or compute with single-flight.

        loader must be an async callable returning the computed value.

        When *stale_ttl_seconds* > 0, expired-but-stale entries are returned
        immediately and a background refresh is scheduled so the next request
        sees a fresh value without blocking.

        endpoint is an optional label (e.g. "tuples", "cells", "picklist") used for per-endpoint stats.
        """
        value, is_stale = await self._get_l1(cache_key)
        if value is not None and not is_stale:
            self._record_hit()
            if endpoint:
                self._stats[f"endpoint_{endpoint}_hits"] = self._stats.get(f"endpoint_{endpoint}_hits", 0) + 1
            return value, CacheMetadata(cache_status="hit", cache_source="l1")

        if value is not None and is_stale:
            # Return the stale value immediately and schedule a background refresh.
            self._record_hit()
            async with self._inflight_lock:
                already_refreshing = cache_key in self._inflight
            if not already_refreshing:
                asyncio.get_running_loop().create_task(
                    self._refresh_in_background(cache_key, loader, ttl_seconds, max_item_bytes, stale_ttl_seconds)
                )
            return value, CacheMetadata(cache_status="hit", cache_source="l1", is_stale=True)

        value, remaining_ttl = await self._get_l2(cache_key)
        if value is not None and remaining_ttl > 0:
            ttl_for_l1 = remaining_ttl
            self._record_hit()
            if endpoint:
                self._stats[f"endpoint_{endpoint}_hits"] = self._stats.get(f"endpoint_{endpoint}_hits", 0) + 1
            await self._store_l1(cache_key, value, ttl_for_l1, len(self._serialize_value(value)), stale_ttl_seconds=stale_ttl_seconds)
            return value, CacheMetadata(cache_status="hit", cache_source="l2")

        # Single-flight dedupe
        owner = False
        async with self._inflight_lock:
            existing = self._inflight.get(cache_key)
            if existing:
                future = existing
            else:
                future = asyncio.get_running_loop().create_future()
                self._inflight[cache_key] = future
                owner = True
            self._stats["inflight"] = len(self._inflight)

        if not owner:
            try:
                result = await future
                self._record_hit()
                if endpoint:
                    self._stats[f"endpoint_{endpoint}_hits"] = self._stats.get(f"endpoint_{endpoint}_hits", 0) + 1
                return result, CacheMetadata(cache_status="hit", cache_source="inflight")
            finally:
                # no cleanup; owner cleans inflight
                pass

        try:
            start = time.perf_counter()
            result = await loader()
            duration_ms = (time.perf_counter() - start) * 1000
            ttl = ttl_seconds if ttl_seconds is not None else self.default_ttl
            item_cap = max_item_bytes if max_item_bytes is not None else self.max_item_bytes
            serialized_size = len(self._serialize_value(result))
            should_admit = duration_ms >= self.admission_min_duration_ms
            if item_cap and item_cap > 0 and serialized_size > item_cap:
                should_admit = False
            if ttl is not None and ttl <= 0:
                should_admit = False
            stored = False
            if should_admit:
                stored = await self._store_all(cache_key, result, ttl, item_cap=item_cap, stale_ttl_seconds=stale_ttl_seconds)
            future.set_result(result)
            self._record_miss()
            if endpoint:
                self._stats[f"endpoint_{endpoint}_misses"] = self._stats.get(f"endpoint_{endpoint}_misses", 0) + 1
            status = "miss" if stored else "bypass"
            source = "compute"
            return result, CacheMetadata(cache_status=status, cache_source=source)
        except Exception as exc:  # pragma: no cover - defensive
            future.set_exception(exc)
            self._record_miss()
            raise
        finally:
            async with self._inflight_lock:
                self._inflight.pop(cache_key, None)
                self._stats["inflight"] = len(self._inflight)

    async def reset(self) -> None:
        """Clear L1 and L2 (used in tests)."""
        async with self._lock:
            self._entries.clear()
            self._stats.update({
                "hits": 0, "misses": 0, "evictions": 0, "current_bytes": 0, "entries": 0, "inflight": 0,
                "endpoint_tuples_hits": 0, "endpoint_tuples_misses": 0,
                "endpoint_cells_hits": 0, "endpoint_cells_misses": 0,
                "endpoint_picklist_hits": 0, "endpoint_picklist_misses": 0,
            })
        if self.store:
            self.store.reset()


_cache_instance: QueryResultCache | None = None
_cache_init_lock: asyncio.Lock | None = None
_cache_lock_loop = None


def _init_lock() -> asyncio.Lock:
    """Return an asyncio.Lock bound to the current loop."""
    global _cache_init_lock, _cache_lock_loop
    loop = asyncio.get_running_loop()
    if _cache_init_lock is None or _cache_lock_loop is not loop:
        _cache_init_lock = asyncio.Lock()
        _cache_lock_loop = loop
    return _cache_init_lock


async def get_query_cache() -> QueryResultCache:
    """Return singleton query cache configured from settings."""
    global _cache_instance
    async with _init_lock():
        if _cache_instance is None:
            settings = get_settings()
            store = None
            if getattr(settings, "cache_sqlite_path", None):
                store = SQLiteCacheStore(settings.cache_sqlite_path, settings.cache_sqlite_max_bytes)
                store.initialize()
            _cache_instance = QueryResultCache(
                max_bytes=settings.cache_max_bytes,
                max_item_bytes=settings.cache_max_item_bytes,
                default_ttl=settings.cache_ttl_seconds,
                admission_min_duration_ms=settings.cache_admission_min_duration_ms,
                store=store,
            )
        return _cache_instance


async def reset_query_cache() -> None:
    """Reset and drop the global cache (tests)."""
    global _cache_instance
    async with _init_lock():
        if _cache_instance:
            await _cache_instance.reset()
            await _cache_instance.close()
        _cache_instance = None
