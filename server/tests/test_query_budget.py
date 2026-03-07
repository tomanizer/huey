"""Tests for query execution budgets: timeout, cancellation, and concurrency caps."""

import asyncio
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress

import pytest
from starlette.testclient import TestClient

from server.config import get_settings
from server.engine import db_manager
from server.query_budget import QueryBudget, reset_query_budget

WAIT_FOR_WAITER_SECONDS = 0.5


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


def test_timeout_uses_per_query_cancel_not_global_interrupt(
    client: TestClient, settings_override, monkeypatch
) -> None:
    """When a query times out the per-cursor cancel_fn is used; the global
    db_manager.interrupt() must NOT be called, so other concurrent queries
    on the shared connection are unaffected (#194)."""
    settings_override(query_timeout_seconds=0.0001)

    global_interrupt_called = {"called": False}

    def mock_global_interrupt() -> None:
        global_interrupt_called["called"] = True

    monkeypatch.setattr(db_manager, "interrupt", mock_global_interrupt)

    r = client.post("/query/cells", json=_cells_body())
    assert r.status_code == 504
    assert r.json()["code"] == "QUERY_TIMEOUT"
    assert not global_interrupt_called["called"], (
        "db_manager.interrupt() must NOT be called when a per-cursor cancel_fn is available"
    )


def test_cancelled_acquire_does_not_increment_active_count(settings_override) -> None:
    """Cancelling while waiting on the semaphore must not leak active slots."""
    settings_override(max_concurrent_queries=1, max_query_queue_depth=1, query_timeout_seconds=5)

    async def scenario() -> None:
        budget = QueryBudget()
        async with budget.acquire():
            assert budget.active_count == 1

            async def wait_for_slot() -> None:
                async with budget.acquire():
                    pytest.fail("Cancelled waiter unexpectedly acquired the semaphore")

            waiter = asyncio.create_task(wait_for_slot())
            deadline = asyncio.get_running_loop().time() + WAIT_FOR_WAITER_SECONDS
            while asyncio.get_running_loop().time() < deadline:
                if budget._waiting == 1:
                    break
                await asyncio.sleep(0.01)
            assert budget._waiting == 1

            waiter.cancel()
            with suppress(asyncio.CancelledError):
                await waiter

            assert budget.active_count == 1
            assert budget._waiting == 0

        assert budget.active_count == 0
        assert budget._waiting == 0

    asyncio.run(scenario())


def test_cancelled_acquire_cleans_waiting_while_queue_lock_is_contended(
    settings_override,
) -> None:
    """Cancellation must still clean waiting counters while queue-lock cleanup waits."""
    settings_override(max_concurrent_queries=1, max_query_queue_depth=1, query_timeout_seconds=5)

    async def scenario() -> None:
        budget = QueryBudget()
        async with budget.acquire():
            assert budget.active_count == 1

            async def wait_for_slot() -> None:
                async with budget.acquire():
                    pytest.fail("Cancelled waiter unexpectedly acquired the semaphore")

            waiter = asyncio.create_task(wait_for_slot())
            deadline = asyncio.get_running_loop().time() + WAIT_FOR_WAITER_SECONDS
            while asyncio.get_running_loop().time() < deadline:
                if budget._waiting == 1:
                    break
                await asyncio.sleep(0.01)
            assert budget._waiting == 1

            await budget._queue_lock.acquire()
            try:
                waiter.cancel()
                await asyncio.sleep(0)
                assert budget._waiting == 1
                assert not waiter.done()
            finally:
                budget._queue_lock.release()

            with suppress(asyncio.CancelledError):
                await waiter

            assert budget.active_count == 1
            assert budget._waiting == 0

        assert budget.active_count == 0
        assert budget._waiting == 0

    asyncio.run(scenario())


def test_disconnect_polling_uses_bounded_interval(settings_override) -> None:
    """Disconnect polling should be rate-limited while a query keeps running."""
    settings_override(query_timeout_seconds=5)
    poll_interval_seconds = 0.05

    class StubRequest:
        def __init__(self) -> None:
            self.poll_count = 0

        async def is_disconnected(self) -> bool:
            self.poll_count += 1
            return False

    async def scenario() -> tuple[int, float]:
        budget = QueryBudget()
        budget._disconnect_poll_interval_seconds = poll_interval_seconds
        request = StubRequest()

        result, execution_ms = await budget.run_with_budget(
            request,
            lambda: asyncio.sleep(0.12, result="ok"),
        )

        assert result == "ok"
        assert execution_ms >= 0
        return request.poll_count, execution_ms

    poll_count, execution_ms = asyncio.run(scenario())
    allowed_poll_count = math.ceil(execution_ms / (poll_interval_seconds * 1000)) + 2
    assert poll_count <= allowed_poll_count
