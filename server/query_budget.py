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

    DEFAULT_DISCONNECT_POLL_INTERVAL_SECONDS = 0.05

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
        self._disconnect_poll_interval_seconds = (
            self.DEFAULT_DISCONNECT_POLL_INTERVAL_SECONDS
        )

    async def _run_cleanup_shielded(self, cleanup: Awaitable[None]) -> None:
        cleanup_task = asyncio.create_task(cleanup)
        try:
            await asyncio.shield(cleanup_task)
        except asyncio.CancelledError:
            await cleanup_task
            raise

    async def _finalize_acquire(self, acquired: bool) -> None:
        async with self._queue_lock:
            self._waiting = max(0, self._waiting - 1)
            if acquired:
                self._active += 1

    async def _release_slot(self) -> None:
        try:
            async with self._queue_lock:
                self._active = max(0, self._active - 1)
        finally:
            self._semaphore.release()

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
        acquired = False
        try:
            await self._semaphore.acquire()
            acquired = True
        finally:
            await self._run_cleanup_shielded(self._finalize_acquire(acquired))

        queue_wait_ms = (time.perf_counter() - queue_start) * 1000
        try:
            yield queue_wait_ms
        finally:
            await self._run_cleanup_shielded(self._release_slot())

    @property
    def active_count(self) -> int:
        """Return the current number of in-flight queries holding a semaphore slot."""
        return self._active

    async def _watch_disconnect(self, request: Request) -> bool:
        """Poll for request disconnect until one is observed or the task is cancelled."""
        while True:
            if await request.is_disconnected():
                return True
            await asyncio.sleep(self._disconnect_poll_interval_seconds)

    def _cancel_disconnect_task(self, disconnect_task: asyncio.Task[Any]) -> None:
        if disconnect_task.done():
            return
        disconnect_task.cancel()

    async def run_with_budget(
        self,
        request: Request,
        coro_factory: Callable[[], Awaitable[Any]],
        cancel_fn: Callable[[], None] | None = None,
    ) -> tuple[Any, float]:
        """Execute a coroutine with timeout and disconnect cancellation.

        When *cancel_fn* is supplied it is called instead of
        ``db_manager.interrupt()`` on timeout or client disconnect.  This
        allows per-query cursor-level cancellation so that unrelated
        concurrent queries on the shared DuckDB connection are not
        interrupted.
        """
        exec_start = time.perf_counter()
        task = asyncio.create_task(coro_factory())
        disconnect_task = asyncio.create_task(self._watch_disconnect(request))
        timeout = self._timeout_seconds if self._timeout_seconds is not None and self._timeout_seconds > 0 else None
        deadline = (time.perf_counter() + timeout) if timeout else None
        try:
            while True:
                wait_timeout = None
                if deadline is not None:
                    wait_timeout = deadline - time.perf_counter()
                    if wait_timeout <= 0:
                        task.cancel()
                        if cancel_fn is not None:
                            cancel_fn()
                        else:
                            db_manager.interrupt()
                        raise QueryTimeoutError(timeout)

                done, _ = await asyncio.wait(
                    {task, disconnect_task},
                    timeout=wait_timeout,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if task in done:
                    self._cancel_disconnect_task(disconnect_task)
                    result = await task
                    execution_ms = (time.perf_counter() - exec_start) * 1000
                    return result, execution_ms
                if disconnect_task in done and disconnect_task.result():
                    task.cancel()
                    if cancel_fn is not None:
                        cancel_fn()
                    else:
                        db_manager.interrupt()
                    raise QueryCancelledError()
        except asyncio.TimeoutError:
            task.cancel()
            if cancel_fn is not None:
                cancel_fn()
            else:
                db_manager.interrupt()
            raise QueryTimeoutError(self._timeout_seconds)
        finally:
            self._cancel_disconnect_task(disconnect_task)


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
