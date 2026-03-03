"""
Query execution budgeting: timeouts, cancellation, and bounded concurrency.
"""

import asyncio
import time
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Callable, Generator

from fastapi import Request

from server.config import get_settings
from server.engine import db_manager
from server.errors import (
    QueryCancelledError,
    QueryTimeoutError,
    TooManyConcurrentQueriesError,
)


class QueryBudget:
    """Enforce per-query timeout and bounded concurrency with queue limits."""

    def __init__(self) -> None:
        settings = get_settings()
        max_concurrent = max(1, settings.max_concurrent_queries)
        self._timeout_seconds = settings.query_timeout_seconds
        self._max_queue_depth = settings.max_query_queue_depth
        self._max_concurrent = max_concurrent
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._queue_lock = asyncio.Lock()
        self._waiting = 0
        self._active = 0

    @asynccontextmanager
    async def acquire(self) -> Generator[float, None, None]:
        """Acquire execution slot; enforce optional queue depth. Returns queue_wait_ms."""
        queue_start = time.perf_counter()
        async with self._queue_lock:
            if (
                self._max_queue_depth is not None
                and self._active + self._waiting >= self._max_concurrent
                and self._waiting >= self._max_queue_depth
            ):
                raise TooManyConcurrentQueriesError(
                    self._max_concurrent, self._max_queue_depth
                )
            self._waiting += 1
        try:
            await self._semaphore.acquire()
        finally:
            async with self._queue_lock:
                self._waiting = max(0, self._waiting - 1)
                self._active += 1

        queue_wait_ms = (time.perf_counter() - queue_start) * 1000
        try:
            yield queue_wait_ms
        finally:
            async with self._queue_lock:
                self._active = max(0, self._active - 1)
            self._semaphore.release()

    async def run_with_budget(
        self,
        request: Request,
        coro_factory: Callable[[], Awaitable[Any]],
    ) -> tuple[Any, float]:
        """Execute a coroutine with timeout and disconnect cancellation."""
        exec_start = time.perf_counter()
        task = asyncio.create_task(coro_factory())
        disconnect_task = asyncio.create_task(request.is_disconnected())
        timeout = self._timeout_seconds if self._timeout_seconds is not None and self._timeout_seconds > 0 else None
        deadline = (time.perf_counter() + timeout) if timeout else None
        try:
            while True:
                wait_timeout = None
                if deadline is not None:
                    wait_timeout = deadline - time.perf_counter()
                    if wait_timeout <= 0:
                        task.cancel()
                        db_manager.interrupt()
                        raise QueryTimeoutError(timeout)

                done, _ = await asyncio.wait(
                    {task, disconnect_task},
                    timeout=wait_timeout,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if task in done:
                    disconnect_task.cancel()
                    result = await task
                    execution_ms = (time.perf_counter() - exec_start) * 1000
                    return result, execution_ms
                if disconnect_task in done and disconnect_task.result():
                    task.cancel()
                    db_manager.interrupt()
                    raise QueryCancelledError()
                if disconnect_task in done and not disconnect_task.result():
                    disconnect_task = asyncio.create_task(request.is_disconnected())
        except asyncio.TimeoutError:
            task.cancel()
            db_manager.interrupt()
            raise QueryTimeoutError(self._timeout_seconds)
        finally:
            if not disconnect_task.done():
                disconnect_task.cancel()


_query_budget: QueryBudget | None = None


def get_query_budget() -> QueryBudget:
    """Return the singleton QueryBudget."""
    global _query_budget
    if _query_budget is None:
        _query_budget = QueryBudget()
    return _query_budget


def reset_query_budget() -> None:
    """Reset the QueryBudget instance (used in tests when settings change)."""
    global _query_budget
    _query_budget = QueryBudget()
