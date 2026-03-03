"""
Query endpoints: /query/tuples, /query/cells, /query/picklist (tech spec).
"""

import logging
import time

from fastapi import APIRouter, Request, Response

from server import datasets
from server.config import get_settings
from fastapi import APIRouter, Depends, Request

from server import datasets
from server.cache import build_cache_key, get_query_cache
from server.config import get_settings
from server.config import get_settings
from server.auth import require_api_key
from server.engine import db_manager
from server.errors import CellsWindowTooLargeError, DatasetNotFoundError
from server.models import (
    CellsResponse,
    PagingResponse,
    PagingSpec,
    PicklistResponse,
    QueryCellsRequest,
    QueryPicklistRequest,
    QueryTuplesRequest,
    TupleItem,
    TuplesResponse,
)
from server.query_builder import (
    build_cells_sql,
    build_picklist_count_sql,
    build_picklist_sql,
    build_tuples_count_sql,
    build_tuples_sql,
)
from server.config import get_settings
from server.query_budget import get_query_budget
from server.request_context import set_request_id
from server.main import limiter

logger = logging.getLogger("query_service.query")
router = APIRouter(prefix="/query", tags=["query"])


def _apply_client_request_id(body, request: Request) -> None:
    """Override correlation ID with client_context.request_id when provided."""
    if body.client_context and body.client_context.request_id:
        rid = body.client_context.request_id
        set_request_id(rid)
        request.state.request_id = rid


async def _execute_with_budget(request: Request, coro):
    """Run a SQL coroutine with query budget enforcement."""
    budget = get_query_budget()
    async with budget.acquire() as queue_wait_ms:
        result, execution_ms = await budget.run_with_budget(request, coro)
    return result, queue_wait_ms, execution_ms


@router.post("/tuples", response_model=TuplesResponse)
@limiter.limit(lambda: get_settings().rate_limit_query)
async def post_query_tuples(body: QueryTuplesRequest, request: Request, _api_key: str = Depends(require_api_key)) -> TuplesResponse:
    """POST /query/tuples: fetch distinct dimension values for one axis."""
    _apply_client_request_id(body, request)
    queue_wait_ms = 0.0
    execution_ms = 0.0
    settings = get_settings()
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise DatasetNotFoundError(body.dataset_id)

    schema_fields = datasets.get_schema_field_names(body.dataset_id)
    paging = body.query.paging or PagingSpec(limit=settings.tuples_default_limit, offset=0)
    limit = paging.limit
    offset = paging.offset

    cache_status = "disabled"
    cache_source = "compute"

    async def _execute() -> dict[str, object]:
        start = time.perf_counter()
        sql, params = build_tuples_sql(body.dataset_id, body.query, body.date_range, schema_fields)
        rows = await db_manager.execute_sql_async(sql, tuple(params) if params else None)
        if rows:
            total_count = int(rows[0][-1])
            items = [{"values": list(row[:-1])} for row in rows]
        else:
            total_count = 0
            items = []

        # Fallback to a lightweight count when page is empty (e.g., offset beyond results)
        if total_count == 0 and (paging.offset if paging else 0) > 0:
            count_sql, count_params = build_tuples_count_sql(body.dataset_id, body.query, body.date_range, schema_fields)
            count_rows = await db_manager.execute_sql_async(count_sql, tuple(count_params) if count_params else None)
            if count_rows:
                total_count = int(count_rows[0][0])
        duration_ms = (time.perf_counter() - start) * 1000
        return {
            "response": {
                "total_count": total_count,
                "items": items,
                "paging": {"limit": limit, "offset": offset, "returned": len(items)},
            },
            "duration_ms": duration_ms,
        }

    result: dict[str, object]
    if getattr(settings, "cache_enabled", False):
        cache = await get_query_cache()
        cache_key = build_cache_key(
            "tuples",
            body.dataset_id,
            body.date_range.model_dump(),
            body.query.model_dump(),
        )
        result, meta = await cache.get_or_set(
            cache_key,
            _execute,
            ttl_seconds=settings.cache_ttl_seconds,
            max_item_bytes=settings.cache_max_item_bytes,
        )
        cache_status = meta.cache_status
        cache_source = meta.cache_source
    else:
        result = await _execute()

    duration_ms = result.get("duration_ms", 0.0)
    resp_body = result["response"]
    logger.info(
        "tuples query executed",
        extra={
            "dataset_id": body.dataset_id,
            "endpoint": "tuples",
            "duration_ms": round(duration_ms, 2),
            "row_count": len(resp_body["items"]),
            "total_count": resp_body["total_count"],
            "cache_status": cache_status,
            "cache_source": cache_source,
            "queue_wait_ms": round(queue_wait_ms, 2),
            "execution_ms": round(execution_ms, 2),
        },
    )

    return TuplesResponse(
        total_count=resp_body["total_count"],
        items=[TupleItem(**item) for item in resp_body["items"]],
        paging=PagingResponse(**resp_body["paging"]),
    )


@router.post("/cells", response_model=CellsResponse)
@limiter.limit(lambda: get_settings().rate_limit_query)
async def post_query_cells(body: QueryCellsRequest, request: Request, _api_key: str = Depends(require_api_key)) -> CellsResponse:
    """POST /query/cells: fetch aggregated cell values grouped by dimensions."""
    _apply_client_request_id(body, request)
    queue_wait_ms = 0.0
    execution_ms = 0.0
    settings = get_settings()
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise DatasetNotFoundError(body.dataset_id)

    schema_fields = datasets.get_schema_field_names(body.dataset_id)
    settings = get_settings()

    row_window = body.query.rows
    col_window = body.query.columns

    row_count = row_window.count if row_window else None
    col_count = col_window.count if col_window else None

    if row_count and row_count > settings.max_axis_cardinality:
        raise CellsWindowTooLargeError(
            "Row window exceeds maximum axis cardinality",
            {"max_axis_cardinality": settings.max_axis_cardinality, "requested_rows": row_count},
        )
    if col_count and col_count > settings.max_axis_cardinality:
        raise CellsWindowTooLargeError(
            "Column window exceeds maximum axis cardinality",
            {"max_axis_cardinality": settings.max_axis_cardinality, "requested_columns": col_count},
        )

    # Guard oversize single-axis requests even when only one dimension is supplied.
    if row_count and row_count > settings.max_cells_per_response:
        raise CellsWindowTooLargeError(
            "Requested row window exceeds maximum cells per response",
            {"max_cells_per_response": settings.max_cells_per_response, "requested_rows": row_count},
        )
    if col_count and col_count > settings.max_cells_per_response:
        raise CellsWindowTooLargeError(
            "Requested column window exceeds maximum cells per response",
            {"max_cells_per_response": settings.max_cells_per_response, "requested_columns": col_count},
        )
    if row_count and col_count and (row_count * col_count) > settings.max_cells_per_response:
        raise CellsWindowTooLargeError(
            "Requested cells window exceeds maximum cells per response",
            {
                "max_cells_per_response": settings.max_cells_per_response,
                "requested_rows": row_count,
                "requested_columns": col_count,
            },
        )

    cache_status = "disabled"
    cache_source = "compute"

    async def _execute() -> dict[str, object]:
        start = time.perf_counter()
        sql, params = build_cells_sql(body.dataset_id, body.query, body.date_range, schema_fields)
        rows = await db_manager.execute_sql_async(sql, tuple(params) if params else None)
        duration_ms = (time.perf_counter() - start) * 1000
        cells = [{"row_index": i, "values": {str(k): v for k, v in enumerate(row)}} for i, row in enumerate(rows)]
        return {"response": {"cells": cells}, "duration_ms": duration_ms, "row_count": len(rows)}

    result: dict[str, object]
    if getattr(settings, "cache_enabled", False):
        cache = await get_query_cache()
        cache_key = build_cache_key(
            "cells",
            body.dataset_id,
            body.date_range.model_dump(),
            body.query.model_dump(),
        )
        # Cells responses can be larger; use stricter TTL and item cap to limit memory.
        ttl = max(1.0, settings.cache_ttl_seconds / 2) if settings.cache_ttl_seconds else settings.cache_ttl_seconds
        max_item = settings.cache_max_item_bytes // 2 if settings.cache_max_item_bytes else settings.cache_max_item_bytes
        result, meta = await cache.get_or_set(
            cache_key,
            _execute,
            ttl_seconds=ttl,
            max_item_bytes=max_item,
        )
        cache_status = meta.cache_status
        cache_source = meta.cache_source
    else:
        result = await _execute()

    duration_ms = result.get("duration_ms", 0.0)
    row_count = result.get("row_count", 0)
    resp_body = result["response"]
    start = time.perf_counter()
    sql, params = build_cells_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    rows = await db_manager.execute_sql_async(
        sql,
        tuple(params) if params else None,
        dataset_id=body.dataset_id,
    )
    duration_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "cells query executed",
        extra={
            "dataset_id": body.dataset_id,
            "endpoint": "cells",
            "duration_ms": round(duration_ms, 2),
            "row_count": row_count,
            "cache_status": cache_status,
            "cache_source": cache_source,
            "row_count": len(rows),
            "queue_wait_ms": round(queue_wait_ms, 2),
            "execution_ms": round(execution_ms, 2),
        },
    )

    return CellsResponse(cells=resp_body["cells"])


@router.post("/picklist", response_model=PicklistResponse)
@limiter.limit(lambda: get_settings().rate_limit_query)
async def post_query_picklist(body: QueryPicklistRequest, request: Request, _api_key: str = Depends(require_api_key)) -> PicklistResponse:
    """POST /query/picklist: fetch distinct values for a field (filter UI)."""
    _apply_client_request_id(body, request)
    queue_wait_ms = 0.0
    execution_ms = 0.0
    settings = get_settings()
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise DatasetNotFoundError(body.dataset_id)

    schema_fields = datasets.get_schema_field_names(body.dataset_id)
    paging = body.query.paging
    paging = paging or PagingSpec(limit=settings.picklist_default_limit, offset=0)
    limit = paging.limit
    offset = paging.offset

    cache_status = "disabled"
    cache_source = "compute"

    async def _execute() -> dict[str, object]:
        start = time.perf_counter()
        sql, params = build_picklist_sql(body.dataset_id, body.query, body.date_range, schema_fields)
        rows = await db_manager.execute_sql_async(sql, tuple(params) if params else None)
        if rows:
            total_count = int(rows[0][-1])
            values = [{"value": str(row[0]), "label": str(row[0])} for row in rows]
        else:
            total_count = 0
            values = []

        # Fallback to count when page is empty (e.g., offset beyond available values)
        if total_count == 0 and (paging.offset if paging else 0) > 0:
            count_sql, count_params = build_picklist_count_sql(body.dataset_id, body.query, body.date_range, schema_fields)
            count_rows = await db_manager.execute_sql_async(count_sql, tuple(count_params) if count_params else None)
            if count_rows:
                total_count = int(count_rows[0][0])
        duration_ms = (time.perf_counter() - start) * 1000
        return {
            "response": {
                "total_count": total_count,
                "values": values,
                "paging": {"limit": limit, "offset": offset, "returned": len(values)},
            },
            "duration_ms": duration_ms,
            "row_count": len(rows),
        }

    result: dict[str, object]
    if getattr(settings, "cache_enabled", False):
        cache = await get_query_cache()
        cache_key = build_cache_key(
            "picklist",
            body.dataset_id,
            body.date_range.model_dump(),
            body.query.model_dump(),
        )
        result, meta = await cache.get_or_set(
            cache_key,
            _execute,
            ttl_seconds=settings.cache_ttl_seconds,
            max_item_bytes=settings.cache_max_item_bytes,
        )
        cache_status = meta.cache_status
        cache_source = meta.cache_source
    start = time.perf_counter()
    sql, params = build_picklist_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    rows = await db_manager.execute_sql_async(
        sql,
        tuple(params) if params else None,
        dataset_id=body.dataset_id,
    )
    if rows:
        total_count = int(rows[0][-1])
        values = [{"value": str(row[0]), "label": str(row[0])} for row in rows]
    else:
        result = await _execute()

    duration_ms = result.get("duration_ms", 0.0)
    resp_body = result["response"]
    # Fallback to count when page is empty (e.g., offset beyond available values)
    if total_count == 0 and (paging.offset if paging else 0) > 0:
        count_sql, count_params = build_picklist_count_sql(body.dataset_id, body.query, body.date_range, schema_fields)
        count_rows = await db_manager.execute_sql_async(
            count_sql,
            tuple(count_params) if count_params else None,
            dataset_id=body.dataset_id,
        )
        if count_rows:
            total_count = int(count_rows[0][0])
    duration_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "picklist query executed",
        extra={
            "dataset_id": body.dataset_id,
            "endpoint": "picklist",
            "duration_ms": round(duration_ms, 2),
            "row_count": result.get("row_count", 0),
            "total_count": resp_body["total_count"],
            "cache_status": cache_status,
            "cache_source": cache_source,
            "row_count": len(rows),
            "total_count": total_count,
            "queue_wait_ms": round(queue_wait_ms, 2),
            "execution_ms": round(execution_ms, 2),
        },
    )

    return PicklistResponse(
        total_count=resp_body["total_count"],
        values=resp_body["values"],
        paging=PagingResponse(**resp_body["paging"]),
    )
