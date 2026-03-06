"""Unit tests for L1 query cache."""

import asyncio

from server.cache import QueryResultCache, build_cache_key, canonical_json


def test_cache_hit_and_stats() -> None:
    async def _run():
        cache = QueryResultCache(max_bytes=1024 * 1024, max_item_bytes=1024 * 1024, default_ttl=5)
        calls = {"count": 0}

        async def loader():
            calls["count"] += 1
            return {"value": "a"}

        value, meta = await cache.get_or_set("k1", loader)
        assert value == {"value": "a"}
        assert meta.cache_status in {"miss", "bypass"}
        value2, meta2 = await cache.get_or_set("k1", loader)
        assert value2 == {"value": "a"}
        assert meta2.cache_status == "hit"
        assert calls["count"] == 1
        stats = cache.stats()
        assert stats["hits"] == 1
        assert stats["misses"] == 1

    asyncio.run(_run())


def test_cache_ttl_expiry_triggers_miss() -> None:
    async def _run():
        cache = QueryResultCache(max_bytes=1024 * 1024, max_item_bytes=1024 * 1024, default_ttl=0.1)
        calls = {"count": 0}

        async def loader():
            calls["count"] += 1
            return "value"

        await cache.get_or_set("ttl", loader)
        await asyncio.sleep(0.12)
        await cache.get_or_set("ttl", loader)
        assert calls["count"] == 2

    asyncio.run(_run())


def test_weighted_eviction_and_lru_update() -> None:
    async def _run():
        cache = QueryResultCache(max_bytes=300, max_item_bytes=300, default_ttl=5)
        calls = {"a": 0, "b": 0, "c": 0}

        async def loader_a():
            calls["a"] += 1
            return "a" * 140

        async def loader_b():
            calls["b"] += 1
            return "b" * 140

        async def loader_c():
            calls["c"] += 1
            return "c" * 140

        await cache.get_or_set("a", loader_a)
        await cache.get_or_set("b", loader_b)
        # Access "a" to make it recently used
        await cache.get_or_set("a", loader_a)
        await cache.get_or_set("c", loader_c)

        # The least-recently-used ("b") should have been evicted when "c" was added.
        await cache.get_or_set("b", loader_b)
        assert calls["b"] == 2  # loader_b executed again after eviction
        stats = cache.stats()
        assert stats["evictions"] >= 1

    asyncio.run(_run())


def test_oversized_item_skipped() -> None:
    async def _run():
        cache = QueryResultCache(max_bytes=1024, max_item_bytes=50, default_ttl=5)
        calls = {"count": 0}

        async def loader():
            calls["count"] += 1
            return "x" * 200

        await cache.get_or_set("big", loader)
        await cache.get_or_set("big", loader)
        assert calls["count"] == 2
        stats = cache.stats()
        assert stats["hits"] == 0

    asyncio.run(_run())


def test_single_flight_deduplicates() -> None:
    async def _run():
        cache = QueryResultCache(max_bytes=1024 * 1024, max_item_bytes=1024 * 1024, default_ttl=5)
        calls = {"count": 0}

        async def loader():
            calls["count"] += 1
            await asyncio.sleep(0.05)
            return {"ok": True}

        results = await asyncio.gather(*(cache.get_or_set("flight", loader) for _ in range(3)))
        assert all(res[0] == {"ok": True} for res in results)
        assert calls["count"] == 1
        stats = cache.stats()
        assert stats["hits"] >= 2
        assert stats["misses"] == 1

    asyncio.run(_run())


def test_cache_key_is_canonical() -> None:
    date_range = {"type": "range", "start": "2026-03-01", "end": "2026-03-02"}
    query_a = {
        "fields": [{"field": "symbol"}, {"field": "region"}],
        "filters": [{"field": "region", "operator": "INCLUDE", "values": ["NA", "EU"]}],
    }
    query_b = {
        "filters": [{"values": ["NA", "EU"], "operator": "INCLUDE", "field": "region"}],
        "fields": [{"field": "symbol"}, {"field": "region"}],
    }
    key_a = build_cache_key("tuples", "ds1", date_range, query_a)
    key_b = build_cache_key("tuples", "ds1", date_range, query_b)
    assert key_a == key_b
    # Canonical JSON must be stable for the same payload
    assert canonical_json({"b": 2, "a": 1}) == canonical_json({"a": 1, "b": 2})


def test_cache_key_differs_by_data_token() -> None:
    """Different data_token values produce different cache keys (dim_version_token behaviour)."""
    date_range = {"type": "single", "date": "2026-03-01"}
    query = {"field": "symbol"}
    key_v1 = build_cache_key("picklist", "ds1", date_range, query, dim_version_token="abc123")
    key_v2 = build_cache_key("picklist", "ds1", date_range, query, dim_version_token="def456")
    assert key_v1 != key_v2
    # Same token must produce the same key every time.
    key_v1b = build_cache_key("picklist", "ds1", date_range, query, dim_version_token="abc123")
    assert key_v1 == key_v1b


def test_cache_key_legacy_and_canonical_tokens_match() -> None:
    """Legacy token parameter names remain compatible with canonical token names."""
    date_range = {"type": "single", "date": "2026-03-01"}
    query = {"field": "symbol"}
    legacy = build_cache_key(
        "picklist",
        "ds1",
        date_range,
        query,
        data_version_token="fact-v1",
        data_token="dim-v1",
    )
    canonical = build_cache_key(
        "picklist",
        "ds1",
        date_range,
        query,
        fact_version_token="fact-v1",
        dim_version_token="dim-v1",
    )
    assert legacy == canonical


def test_cache_key_differs_by_config_token() -> None:
    """Config identity changes must alter cache keys for schema/config invalidation."""
    date_range = {"type": "single", "date": "2026-03-01"}
    query = {"field": "symbol"}
    key_v1 = build_cache_key(
        "picklist",
        "ds1",
        date_range,
        query,
        config_token={"path": "/cfg/datasets.yaml", "mtime": 100.0},
    )
    key_v2 = build_cache_key(
        "picklist",
        "ds1",
        date_range,
        query,
        config_token={"path": "/cfg/datasets.yaml", "mtime": 101.0},
    )
    assert key_v1 != key_v2


def test_stale_while_revalidate_returns_stale_immediately() -> None:
    """Stale entries within the stale window are returned synchronously without calling the loader."""
    import time

    from server.cache import _CacheEntry

    async def _run():
        cache = QueryResultCache(max_bytes=1024 * 1024, max_item_bytes=1024 * 1024, default_ttl=60)

        now = time.monotonic()
        # Insert a manually crafted stale entry: expired 5 s ago, but stale window extends 300 s.
        stale_entry = _CacheEntry(
            value={"items": ["stale_value"]},
            size_bytes=100,
            expires_at=now - 5.0,  # already past fresh TTL
            stale_until=now + 300.0,  # still within stale serving window
        )
        cache._entries["stale_key"] = stale_entry
        cache._stats["current_bytes"] += stale_entry.size_bytes
        cache._stats["entries"] = 1

        loader_calls = 0

        async def loader():
            nonlocal loader_calls
            loader_calls += 1
            return {"items": ["fresh_value"]}

        result, meta = await cache.get_or_set(
            "stale_key",
            loader,
            ttl_seconds=60.0,
            stale_ttl_seconds=300.0,
        )

        # Stale value is returned immediately without calling the loader.
        assert result == {"items": ["stale_value"]}
        assert meta.cache_status == "hit"
        assert meta.cache_source == "l1"
        assert meta.is_stale is True
        assert loader_calls == 0  # Loader was NOT called synchronously

        await cache.close()

    asyncio.run(_run())


def test_per_endpoint_stats() -> None:
    async def _run():
        cache = QueryResultCache(max_bytes=1024 * 1024, max_item_bytes=1024 * 1024, default_ttl=5)

        async def loader():
            return {"data": "ok"}

        # Miss on tuples
        await cache.get_or_set("t1", loader, endpoint="tuples")
        # Hit on tuples
        await cache.get_or_set("t1", loader, endpoint="tuples")
        # Miss on cells
        await cache.get_or_set("c1", loader, endpoint="cells")
        # Miss on picklist
        await cache.get_or_set("p1", loader, endpoint="picklist")
        # Hit on picklist
        await cache.get_or_set("p1", loader, endpoint="picklist")

        stats = cache.stats()
        assert stats["endpoint_tuples_hits"] == 1
        assert stats["endpoint_tuples_misses"] == 1
        assert stats["endpoint_cells_hits"] == 0
        assert stats["endpoint_cells_misses"] == 1
        assert stats["endpoint_picklist_hits"] == 1
        assert stats["endpoint_picklist_misses"] == 1

        await cache.close()

    asyncio.run(_run())


def test_stale_entry_fully_expired_causes_miss() -> None:
    """Entries past the stale window are evicted and cause a cache miss."""
    import time

    from server.cache import _CacheEntry

    async def _run():
        cache = QueryResultCache(max_bytes=1024 * 1024, max_item_bytes=1024 * 1024, default_ttl=60)

        now = time.monotonic()
        # Both expires_at and stale_until are in the past.
        expired_entry = _CacheEntry(
            value={"items": ["old"]},
            size_bytes=100,
            expires_at=now - 20.0,
            stale_until=now - 5.0,
        )
        cache._entries["expired_key"] = expired_entry
        cache._stats["current_bytes"] += expired_entry.size_bytes
        cache._stats["entries"] = 1

        loader_calls = 0

        async def loader():
            nonlocal loader_calls
            loader_calls += 1
            return {"items": ["fresh"]}

        result, meta = await cache.get_or_set("expired_key", loader, ttl_seconds=60.0, stale_ttl_seconds=300.0)

        assert result == {"items": ["fresh"]}
        assert meta.cache_status in {"miss", "bypass"}
        assert loader_calls == 1  # Loader must have been called

        await cache.close()

    asyncio.run(_run())


def test_stats_include_all_expected_keys() -> None:
    async def _run():
        cache = QueryResultCache(max_bytes=1024 * 1024, max_item_bytes=1024 * 1024, default_ttl=5)
        stats = cache.stats()
        for key in ("hits", "misses", "evictions", "current_bytes", "entries", "inflight",
                    "endpoint_tuples_hits", "endpoint_tuples_misses",
                    "endpoint_cells_hits", "endpoint_cells_misses",
                    "endpoint_picklist_hits", "endpoint_picklist_misses"):
            assert key in stats, f"Missing stat key: {key}"

        await cache.close()

    asyncio.run(_run())
