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
