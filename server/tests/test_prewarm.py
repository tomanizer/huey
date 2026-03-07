"""Tests for dimension cache prewarming."""

import asyncio

import pytest

from server import datasets
from server.cache import build_cache_key, get_query_cache, reset_query_cache
from server.config import get_settings
from server.engine import db_manager
from server.models import PicklistQueryBody
from server.prewarm import prewarm_dim_fields


class _RecordingCache:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def get_or_set(self, cache_key, loader, **kwargs):
        value = await loader()
        self.calls.append({"cache_key": cache_key, "value": value, **kwargs})
        return value, None


@pytest.fixture(autouse=True)
def _reset_prewarm_state(monkeypatch):
    asyncio.run(reset_query_cache())
    datasets.clear_partition_metadata()
    get_settings.cache_clear()
    yield
    asyncio.run(reset_query_cache())
    datasets.clear_partition_metadata()
    get_settings.cache_clear()
    for env_var in [
        "QUERYSERVICE_DIM_PREWARM_FIELDS",
        "QUERYSERVICE_DIM_PREWARM_DATE",
        "QUERYSERVICE_DIM_PREWARM_DATE_MODE",
        "QUERYSERVICE_DIM_STALE_TTL_SECONDS",
        "QUERYSERVICE_DIM_VERSION_TOKEN",
    ]:
        monkeypatch.delenv(env_var, raising=False)


def test_prewarm_uses_latest_available_date_and_runtime_picklist_key(monkeypatch, caplog) -> None:
    monkeypatch.setenv("QUERYSERVICE_DIM_PREWARM_FIELDS", "trades_v1:symbol")
    monkeypatch.setenv("QUERYSERVICE_DIM_PREWARM_DATE_MODE", "latest_available")
    monkeypatch.setenv("QUERYSERVICE_DIM_VERSION_TOKEN", "dim-v1")
    get_settings.cache_clear()
    datasets.set_partition_metadata(
        "trades_v1",
        {
            "partitions": [
                {"date": "2026-02-27", "files": [{"path": "older.parquet", "size": 1, "etag": "e1"}]},
                {"date": "2026-03-01", "files": [{"path": "latest.parquet", "size": 2, "etag": "e2"}]},
            ]
        },
    )

    with caplog.at_level("INFO", logger="query_service.prewarm"):
        asyncio.run(prewarm_dim_fields())

    settings = get_settings()
    cache = asyncio.run(get_query_cache())
    expected_key = build_cache_key(
        "picklist",
        "trades_v1",
        {"type": "single", "date": "2026-03-01"},
        PicklistQueryBody(field="symbol").model_dump(),
        dim_version_token="dim-v1",
    )

    async def fail_loader():
        raise AssertionError("expected prewarm cache hit")

    result, meta = asyncio.run(
        cache.get_or_set(
            expected_key,
            fail_loader,
            ttl_seconds=float(settings.dim_cache_ttl_seconds),
            max_item_bytes=settings.cache_max_item_bytes,
            stale_ttl_seconds=float(settings.dim_stale_ttl_seconds),
            endpoint="picklist",
        )
    )

    assert meta.cache_status == "hit"
    assert result["response"]["total_count"] > 0
    assert any(
        getattr(record, "selected_date", None) == "2026-03-01"
        and getattr(record, "date_strategy", None) == "latest_available"
        for record in caplog.records
    )


def test_prewarm_skips_invalid_and_unknown_specs(monkeypatch, caplog) -> None:
    monkeypatch.setenv(
        "QUERYSERVICE_DIM_PREWARM_FIELDS",
        "broken-spec,missing_dataset:symbol,trades_v1:not_a_field",
    )
    get_settings.cache_clear()

    async def fail_sql(*args, **kwargs):
        raise AssertionError("invalid or unknown specs should not query the database")

    monkeypatch.setattr(db_manager, "execute_sql_async", fail_sql)

    with caplog.at_level("WARNING", logger="query_service.prewarm"):
        asyncio.run(prewarm_dim_fields())

    messages = [record.getMessage() for record in caplog.records]
    assert any("Skipping invalid prewarm spec" in message for message in messages)
    assert any("Skipping prewarm for unknown dataset" in message for message in messages)
    assert any("Skipping prewarm for unknown field" in message for message in messages)


def test_prewarm_honors_configured_date_and_cache_options(monkeypatch, caplog) -> None:
    monkeypatch.setenv("QUERYSERVICE_DIM_PREWARM_FIELDS", "trades_v1:symbol")
    monkeypatch.setenv("QUERYSERVICE_DIM_PREWARM_DATE", "2026-02-28")
    monkeypatch.setenv("QUERYSERVICE_DIM_PREWARM_DATE_MODE", "latest_available")
    monkeypatch.setenv("QUERYSERVICE_DIM_STALE_TTL_SECONDS", "123")
    monkeypatch.setenv("QUERYSERVICE_DIM_VERSION_TOKEN", "forced-dim-token")
    get_settings.cache_clear()
    datasets.set_partition_metadata(
        "trades_v1",
        {"partitions": [{"date": "2026-03-01", "files": [{"path": "latest.parquet", "size": 1, "etag": "e1"}]}]},
    )

    recording_cache = _RecordingCache()

    async def fake_get_query_cache():
        return recording_cache

    monkeypatch.setattr("server.cache.get_query_cache", fake_get_query_cache)

    with caplog.at_level("INFO", logger="query_service.prewarm"):
        asyncio.run(prewarm_dim_fields())

    assert len(recording_cache.calls) == 1
    call = recording_cache.calls[0]
    assert call["cache_key"] == build_cache_key(
        "picklist",
        "trades_v1",
        {"type": "single", "date": "2026-02-28"},
        PicklistQueryBody(field="symbol").model_dump(),
        dim_version_token="forced-dim-token",
    )
    assert call["stale_ttl_seconds"] == 123.0
    assert any(getattr(record, "selected_date", None) == "2026-02-28" for record in caplog.records)


def test_prewarm_query_failure_is_logged_and_startup_continues(monkeypatch, caplog) -> None:
    monkeypatch.setenv("QUERYSERVICE_DIM_PREWARM_FIELDS", "trades_v1:symbol,trades_v1:date")
    monkeypatch.setenv("QUERYSERVICE_DIM_PREWARM_DATE", "2026-03-01")
    get_settings.cache_clear()

    original = db_manager.execute_sql_async
    call_count = {"n": 0}

    async def flaky_execute(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("boom")
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", flaky_execute)

    with caplog.at_level("INFO", logger="query_service.prewarm"):
        asyncio.run(prewarm_dim_fields())

    settings = get_settings()
    cache = asyncio.run(get_query_cache())
    expected_key = build_cache_key(
        "picklist",
        "trades_v1",
        {"type": "single", "date": "2026-03-01"},
        PicklistQueryBody(field="date").model_dump(),
        dim_version_token=datasets.get_dim_version_token("trades_v1"),
    )

    async def fail_loader():
        raise AssertionError("expected warmed cache entry for second field")

    _, meta = asyncio.run(
        cache.get_or_set(
            expected_key,
            fail_loader,
            ttl_seconds=float(settings.dim_cache_ttl_seconds),
            max_item_bytes=settings.cache_max_item_bytes,
            stale_ttl_seconds=float(settings.dim_stale_ttl_seconds),
            endpoint="picklist",
        )
    )

    assert meta.cache_status == "hit"
    assert any("Failed to prewarm dim cache for trades_v1:symbol" in record.getMessage() for record in caplog.records)
    assert any(getattr(record, "warmed_count", None) == 1 for record in caplog.records)
