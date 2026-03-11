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
        "QUERYSERVICE_DIM_CACHE_TTL_SECONDS",
        "QUERYSERVICE_DIM_STALE_TTL_SECONDS",
        "QUERYSERVICE_DIM_VERSION_TOKEN",
        "QUERYSERVICE_DIM_PREWARM_FIELDS",
    ]:
        monkeypatch.delenv(env_var, raising=False)


def _enable_cache(monkeypatch, *, max_item_bytes: int | None = None) -> None:
    monkeypatch.setenv("QUERYSERVICE_CACHE_ENABLED", "true")
    if max_item_bytes is not None:
        monkeypatch.setenv("QUERYSERVICE_CACHE_MAX_ITEM_BYTES", str(max_item_bytes))
    get_settings.cache_clear()
    asyncio.run(reset_query_cache())


def _tuples_body() -> dict:
    return {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "fields": [{"field": "symbol"}],
        "paging": {"limit": 10, "offset": 0},
    }


def _members_body() -> dict:
    return {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "field": "symbol",
        "paging": {"limit": 5, "offset": 0},
    }


def _cells_body() -> dict:
    return {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
        },
    }


def test_tuples_cache_hit(monkeypatch, client: TestClient) -> None:
    _enable_cache(monkeypatch)
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = _tuples_body()
    r1 = client.post("/api/v1/datasets/trades_v1/query/tuples", json=body)
    r2 = client.post("/api/v1/datasets/trades_v1/query/tuples", json=body)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json() == r2.json()
    assert call_count["n"] == 1


def test_picklist_cache_hit(monkeypatch, client: TestClient) -> None:
    _enable_cache(monkeypatch)
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = _members_body()
    r1 = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    r2 = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json() == r2.json()
    assert call_count["n"] == 1


def test_cells_cache_hit(monkeypatch, client: TestClient) -> None:
    _enable_cache(monkeypatch)
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = _cells_body()
    r1 = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    r2 = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    assert r1.status_code == 200
    assert r2.status_code == 200
    data1 = r1.json()
    data2 = r2.json()
    assert data1["cells"]
    assert data1["rows"] == data2["rows"]
    assert data1["columns"] == data2["columns"]
    assert data1["cells"] == data2["cells"]
    assert data1["window"] == data2["window"]
    assert data1["meta"]["cache_status"] == "miss"
    assert data2["meta"]["cache_status"] == "hit"
    assert data1["meta"]["request_id"] != data2["meta"]["request_id"]
    assert call_count["n"] == 2


def test_cells_not_cached_when_too_large(monkeypatch, client: TestClient) -> None:
    _enable_cache(monkeypatch, max_item_bytes=10)
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = _cells_body()
    r1 = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    r2 = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["cells"]
    assert call_count["n"] == 4


def test_picklist_dim_version_token_cache_hit(monkeypatch, client: TestClient) -> None:
    """Repeat picklist requests with the same dim_version_token are served from cache."""
    _enable_cache(monkeypatch)
    monkeypatch.setenv("QUERYSERVICE_DIM_VERSION_TOKEN", "v1-stable")
    get_settings.cache_clear()
    asyncio.run(reset_query_cache())

    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = _members_body()
    r1 = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    r2 = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    assert r1.status_code == 200
    assert r2.status_code == 200
    # Second request must be a cache hit – DB should only be called once.
    assert call_count["n"] == 1


def test_cache_miss_when_data_version_token_changes(monkeypatch, client: TestClient) -> None:
    _enable_cache(monkeypatch)
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = _tuples_body()
    datasets.set_partition_metadata(
        "trades_v1",
        {"partitions": [{"date": "2026-03-01", "files": [{"path": "p1.parquet", "size": 100, "etag": "e1"}]}]},
    )
    r1 = client.post("/api/v1/datasets/trades_v1/query/tuples", json=body)

    datasets.set_partition_metadata(
        "trades_v1",
        {"partitions": [{"date": "2026-03-01", "files": [{"path": "p1.parquet", "size": 101, "etag": "e1"}]}]},
    )
    r2 = client.post("/api/v1/datasets/trades_v1/query/tuples", json=body)

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert call_count["n"] == 2


def test_picklist_dim_version_token_cache_miss_on_token_change(monkeypatch, client: TestClient) -> None:
    """Changing dim_version_token causes a cache miss and triggers a fresh query."""
    _enable_cache(monkeypatch)

    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = _members_body()

    # First request with token v1.
    monkeypatch.setenv("QUERYSERVICE_DIM_VERSION_TOKEN", "token-v1")
    get_settings.cache_clear()
    r1 = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    assert r1.status_code == 200
    assert call_count["n"] == 1

    # Change the token – the cache key changes, so this is a miss.
    monkeypatch.setenv("QUERYSERVICE_DIM_VERSION_TOKEN", "token-v2")
    get_settings.cache_clear()
    r2 = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    assert r2.status_code == 200
    assert call_count["n"] == 2  # DB called again due to key change


def test_dim_version_token_change_does_not_invalidate_fact_cache(monkeypatch, client: TestClient) -> None:
    """Dimension token bumps should not invalidate tuples/cells fact cache keys."""
    _enable_cache(monkeypatch)

    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)

    body = _tuples_body()

    monkeypatch.setenv("QUERYSERVICE_DIM_VERSION_TOKEN", "dim-v1")
    get_settings.cache_clear()
    r1 = client.post("/api/v1/datasets/trades_v1/query/tuples", json=body)
    assert r1.status_code == 200
    assert r1.json().get("items")
    assert call_count["n"] == 1

    monkeypatch.setenv("QUERYSERVICE_DIM_VERSION_TOKEN", "dim-v2")
    get_settings.cache_clear()
    r2 = client.post("/api/v1/datasets/trades_v1/query/tuples", json=body)
    assert r2.status_code == 200
    assert call_count["n"] == 1
