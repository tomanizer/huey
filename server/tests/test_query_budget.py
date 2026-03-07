"""Tests for query execution budgets: timeout, cancellation, and concurrency caps."""

import asyncio
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from starlette.testclient import TestClient

from server.config import get_settings
from server.engine import db_manager
from server.query_budget import reset_query_budget


@pytest.fixture
def settings_override(monkeypatch):
    """Override QUERYSERVICE_* settings for a single test and reset caches.

    Always forces sample_table execution mode so tests run against in-memory
    DuckDB data rather than S3 parquet paths.
    """

    def _apply(**kwargs):
        # Always use sample_table mode in budget tests to avoid S3 access.
        monkeypatch.setenv("QUERYSERVICE_EXECUTION_MODE", "sample_table")
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
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"axes": {"rows": [{"field": "symbol"}], "columns": [], "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}]}},
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
    settings_override(max_concurrent_queries=1, max_query_queue_depth=0, query_timeout_seconds=5)

    original_execute = db_manager.execute_sql_async
    # Signal set when the first request has entered execute_sql_async, meaning
    # the budget semaphore is already acquired and held.
    in_execute = threading.Event()

    async def slow_execute(sql, params=None, *, dataset_id=None, cancel_handle=None):
        in_execute.set()  # budget is held at this point
        await asyncio.sleep(1)
        return await original_execute(sql, params, dataset_id=dataset_id, cancel_handle=cancel_handle)

    monkeypatch.setattr(db_manager, "execute_sql_async", slow_execute)

    request_body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"axes": {"rows": [{"field": "symbol"}], "columns": [], "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}]}},
    }

    def first_request():
        # Separate clients avoid TestClient internal request serialization,
        # which can make this concurrency test nondeterministic.
        return first_client.post("/query/cells", json=request_body)

    first_client = None
    second_client = None
    try:
        first_client = TestClient(client.app)
        second_client = TestClient(client.app)
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(first_request)
            # Wait until the first request has definitely acquired the budget slot
            # before sending the second, so the queue overflow is guaranteed.
            assert in_execute.wait(timeout=5)
            second_result = second_client.post("/query/cells", json=request_body)
            first_result = first.result(timeout=10)
    finally:
        if first_client is not None:
            first_client.close()
        if second_client is not None:
            second_client.close()

    assert first_result.status_code in (200, 504)
    assert second_result.status_code == 429
    assert second_result.json()["code"] == "TOO_MANY_QUERIES"


def test_timing_out_one_request_does_not_break_other_concurrent_requests(
    client: TestClient, settings_override, monkeypatch
) -> None:
    """Timing out one request should not cause unrelated concurrent requests to fail."""
    timeout_seconds = 0.2
    slow_query_delay_seconds = timeout_seconds + 0.8
    settings_override(
        query_timeout_seconds=timeout_seconds,
        max_concurrent_queries=2,
        max_query_queue_depth=1,
    )

    original_execute = db_manager.execute_sql_async
    monkeypatch.setattr(
        db_manager,
        "interrupt",
        lambda: pytest.fail("db_manager.interrupt() should not be used for query-scoped timeouts"),
    )
    first_started = threading.Event()
    call_lock = threading.Lock()
    call_count = {"value": 0}

    async def mock_execute(_sql, _params=None, *, dataset_id=None, cancel_handle=None):
        with call_lock:
            call_count["value"] += 1
            call_number = call_count["value"]

        if call_number == 1:
            first_started.set()
            await asyncio.sleep(slow_query_delay_seconds)
            return [[-1]]

        return await original_execute(
            "SELECT 42 AS v",
            None,
            dataset_id=dataset_id,
            cancel_handle=cancel_handle,
        )

    monkeypatch.setattr(db_manager, "execute_sql_async", mock_execute)

    request_body = _cells_body()

    first_client = None
    second_client = None
    try:
        first_client = TestClient(client.app)
        second_client = TestClient(client.app)

        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(first_client.post, "/query/cells", json=request_body)
            assert first_started.wait(timeout=5)
            second_result = second_client.post("/query/cells", json=request_body)
            first_result = first.result(timeout=10)
    finally:
        if first_client is not None:
            first_client.close()
        if second_client is not None:
            second_client.close()

    assert first_result.status_code == 504
    assert first_result.json()["code"] == "QUERY_TIMEOUT"
    assert second_result.status_code == 200
    assert second_result.json()["cells"] == [{"row_index": 0, "values": {"0": 42}}]
