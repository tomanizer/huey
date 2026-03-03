"""Tests for query execution budgets: timeout, cancellation, and concurrency caps."""

import asyncio
import os
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from starlette.testclient import TestClient

from server.config import get_settings
from server.engine import db_manager
from server.query_budget import reset_query_budget


@pytest.fixture
def settings_override(monkeypatch):
    """Override QUERYSERVICE_* settings for a single test and reset caches."""

    def _apply(**kwargs):
        for key, value in kwargs.items():
            env_key = f"QUERYSERVICE_{key.upper()}"
            monkeypatch.setenv(env_key, str(value))
        get_settings.cache_clear()
        reset_query_budget()

    yield _apply

    # Reset after test
    for key in list(os.environ.keys()):
        if key.startswith("QUERYSERVICE_"):
            monkeypatch.delenv(key, raising=False)
    get_settings.cache_clear()
    reset_query_budget()


def _cells_body():
    return {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2024-01-15"},
        "query": {"axes": {"rows": [{"field": "symbol"}], "measures": [{"field": "price", "aggregation": "SUM"}]}},
    }


def test_query_timeout_response(client: TestClient, settings_override) -> None:
    """Queries exceeding the timeout return a 504 with QUERY_TIMEOUT."""
    settings_override(query_timeout_seconds=0.0001)
    r = client.post("/query/cells", json=_cells_body())
    assert r.status_code == 504
    body = r.json()
    assert body["code"] == "QUERY_TIMEOUT"
    assert body["details"]["timeout_seconds"] == 0.0001


def test_queue_depth_rejects_overflow(
    client: TestClient, settings_override, monkeypatch
) -> None:
    """When queue depth is exceeded, subsequent requests fail fast."""
    settings_override(max_concurrent_queries=1, max_query_queue_depth=0, query_timeout_seconds=1)

    original_execute = db_manager.execute_sql_async

    async def slow_execute(sql, params=None):
        await asyncio.sleep(0.1)
        return await original_execute(sql, params)

    monkeypatch.setattr(db_manager, "execute_sql_async", slow_execute)

    def slow_request():
        return client.post(
            "/query/cells",
            json={
                "dataset_id": "trades_v1",
                "date_range": {"type": "single", "date": "2024-01-15"},
                "query": {"axes": {"rows": [{"field": "symbol"}]}, "filters": [{"field": "symbol", "operator": "INCLUDE", "values": ["AAPL"]}]},
            },
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(slow_request)
        time.sleep(0.01)
        second = pool.submit(slow_request)
        first_result = first.result(timeout=5)
        second_result = second.result(timeout=5)

    assert first_result.status_code in (200, 504)
    assert second_result.status_code == 429
    assert second_result.json()["code"] == "TOO_MANY_QUERIES"
