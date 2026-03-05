"""API-level cache behavior tests."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from server import datasets
from server.cache import reset_query_cache
from server.config import get_settings
from server.engine import db_manager


@pytest.fixture(autouse=True)
def _reset_cache_state(monkeypatch):
    asyncio.run(reset_query_cache())
    datasets.clear_partition_metadata()
    get_settings.cache_clear()
    yield
    asyncio.run(reset_query_cache())
    datasets.clear_partition_metadata()
    get_settings.cache_clear()
    for env_var in [
        "QUERYSERVICE_CACHE_ENABLED",
        "QUERYSERVICE_CACHE_TTL_SECONDS",
        "QUERYSERVICE_CACHE_MAX_BYTES",
        "QUERYSERVICE_CACHE_MAX_ITEM_BYTES",
        "QUERYSERVICE_CACHE_ADMISSION_MIN_DURATION_MS",
        "QUERYSERVICE_CACHE_SQLITE_PATH",
        "QUERYSERVICE_CACHE_SQLITE_MAX_BYTES",
    ]:
        monkeypatch.delenv(env_var, raising=False)


def _enable_cache(monkeypatch, *, max_item_bytes: int | None = None) -> None:
    monkeypatch.setenv("QUERYSERVICE_CACHE_ENABLED", "true")
    if max_item_bytes is not None:
        monkeypatch.setenv("QUERYSERVICE_CACHE_MAX_ITEM_BYTES", str(max_item_bytes))
    get_settings.cache_clear()
    asyncio.run(reset_query_cache())


def test_tuples_cache_hit(monkeypatch, client: TestClient) -> None:
    _enable_cache(monkeypatch)
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(sql, params=None, *, dataset_id=None):
        call_count["n"] += 1
        return await original(sql, params, dataset_id=dataset_id)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 0}},
    }
    r1 = client.post("/query/tuples", json=body)
    r2 = client.post("/query/tuples", json=body)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert call_count["n"] == 1


def test_picklist_cache_hit(monkeypatch, client: TestClient) -> None:
    _enable_cache(monkeypatch)
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(sql, params=None, *, dataset_id=None):
        call_count["n"] += 1
        return await original(sql, params, dataset_id=dataset_id)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "paging": {"limit": 5, "offset": 0}},
    }
    r1 = client.post("/query/picklist", json=body)
    r2 = client.post("/query/picklist", json=body)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert call_count["n"] == 1


def test_cells_not_cached_when_too_large(monkeypatch, client: TestClient) -> None:
    _enable_cache(monkeypatch, max_item_bytes=10)
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(sql, params=None, *, dataset_id=None):
        call_count["n"] += 1
        return await original(sql, params, dataset_id=dataset_id)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {},
    }
    r1 = client.post("/query/cells", json=body)
    r2 = client.post("/query/cells", json=body)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert call_count["n"] == 2


def test_cache_miss_when_data_version_token_changes(monkeypatch, client: TestClient) -> None:
    _enable_cache(monkeypatch)
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(sql, params=None, *, dataset_id=None):
        call_count["n"] += 1
        return await original(sql, params, dataset_id=dataset_id)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 0}},
    }
    datasets.set_partition_metadata(
        "trades_v1",
        {"partitions": [{"date": "2026-03-01", "files": [{"path": "p1.parquet", "size": 100, "etag": "e1"}]}]},
    )
    r1 = client.post("/query/tuples", json=body)

    datasets.set_partition_metadata(
        "trades_v1",
        {"partitions": [{"date": "2026-03-01", "files": [{"path": "p1.parquet", "size": 101, "etag": "e1"}]}]},
    )
    r2 = client.post("/query/tuples", json=body)

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert call_count["n"] == 2
