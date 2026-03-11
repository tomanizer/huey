"""Tests for dimension-cache prewarming."""

import asyncio
from types import SimpleNamespace

import server.cache as cache_module
import server.config as config_module
import server.datasets as datasets_module
import server.engine as engine_module
import server.query_builder as query_builder_module
from server.prewarm import prewarm_dim_fields


class _FakeCache:
    def __init__(self):
        self.calls = []

    async def get_or_set(self, cache_key, loader, **kwargs):
        value = await loader()
        self.calls.append({"cache_key": cache_key, "value": value, "kwargs": kwargs})
        return value, None


def test_prewarm_members_uses_members_cache_key_and_response_shape(monkeypatch) -> None:
    captured = {"build_cache_key": None}
    fake_cache = _FakeCache()

    monkeypatch.setattr(
        config_module,
        "get_settings",
        lambda: SimpleNamespace(
            dim_prewarm_fields="trades_v1:symbol",
            picklist_default_limit=100,
            dim_cache_ttl_seconds=60,
            dim_stale_ttl_seconds=30,
            cache_max_item_bytes=1024 * 1024,
        ),
    )
    async def _get_query_cache():
        return fake_cache

    monkeypatch.setattr(cache_module, "get_query_cache", _get_query_cache)
    monkeypatch.setattr(datasets_module, "get_schema_field_names", lambda dataset_id: {"symbol"} if dataset_id == "trades_v1" else set())
    monkeypatch.setattr(datasets_module, "get_dim_version_token", lambda _dataset_id: "dim-v1")
    monkeypatch.setattr(query_builder_module, "build_picklist_sql", lambda *_args, **_kwargs: ("SELECT 1", []))

    async def _execute_sql_async(*_args, **_kwargs):
        return [("AAPL", 2, 3), ("GOOG", 1, 3)]

    monkeypatch.setattr(engine_module.db_manager, "execute_sql_async", _execute_sql_async)

    def _build_cache_key(endpoint, dataset_id, date_range, query_payload, **kwargs):
        captured["build_cache_key"] = {
            "endpoint": endpoint,
            "dataset_id": dataset_id,
            "date_range": date_range,
            "query_payload": query_payload,
            "kwargs": kwargs,
        }
        return "members-cache-key"

    monkeypatch.setattr(cache_module, "build_cache_key", _build_cache_key)

    asyncio.run(prewarm_dim_fields())

    assert captured["build_cache_key"] is not None
    assert captured["build_cache_key"]["endpoint"] == "members"
    assert captured["build_cache_key"]["dataset_id"] == "trades_v1"
    assert fake_cache.calls
    payload = fake_cache.calls[0]["value"]["response"]
    assert payload["field"] == "symbol"
    assert payload["items"] == [{"value": "AAPL", "count": 2}, {"value": "GOOG", "count": 1}]
    assert payload["paging"]["returned"] == 2
