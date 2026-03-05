"""
Query endpoints: /query/tuples, /query/cells, /query/picklist (tech spec).
"""

import logging
import time

from fastapi import APIRouter, Depends, Request, Response

from server import datasets
from server.auth import require_api_key
from server.cache import build_cache_key, get_query_cache
from server.config import get_settings
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
from server.query_budget import get_query_budget
from server.query_builder import (
    build_cells_sql,
    build_picklist_count_sql,
    build_picklist_sql,
    build_tuples_count_sql,
    build_tuples_sql,
)
from server.rate_limit import limiter
from server.request_context import set_request_id

logger = logging.getLogger("query_service.query")
router = APIRouter(prefix="/query", tags=["query"])


def _apply_client_request_id(body, request: Request) -> None:
    """Override correlation ID with client_context.request_id when provided."""
    if body.client_context and body.client_context.request_id:
        rid = body.client_context.request_id
        set_request_id(rid)
        request.state.request_id = rid


def _time_filter_metadata(dataset_id: str) -> tuple[bool, str | None]:
    """Describe whether date_range is actively applied for dataset execution."""
    settings = get_settings()
    if settings.execution_mode != "parquet_partitioned":
        return True, "date"
    source = datasets.get_dataset_source(dataset_id)
    if source is None:
        return True, "date"
    if source.time_filter is None:
        return False, None
    return True, source.time_filter.column


@router.post("/tuples", response_model=TuplesResponse)
@limiter.limit(lambda: get_settings().rate_limit_query)
async def post_query_tuples(body: QueryTuplesRequest, request: Request, response: Response, _api_key: str = Depends(require_api_key)) -> TuplesResponse:
    """POST /query/tuples: fetch distinct dimension values for one axis."""
    _apply_client_request_id(body, request)
    queue_wait_ms = 0.0
    execution_ms = 0.0
    settings = get_settings()
    if datasets.get_schema(body.dataset_id) is None:
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
        rows = await db_manager.execute_sql_fetchmany_async(
            sql,
            tuple(params) if params else None,
            dataset_id=body.dataset_id,
            batch_size=settings.query_fetchmany_batch_size,
        )
        if rows:
            total_count = int(rows[0][-1])
            items = [{"values": list(row[:-1])} for row in rows]
        else:
            total_count = 0
            items = []

        if total_count == 0 and paging.offset > 0:
            count_sql, count_params = build_tuples_count_sql(body.dataset_id, body.query, body.date_range, schema_fields)
            count_rows = await db_manager.execute_sql_fetchmany_async(
                count_sql,
                tuple(count_params) if count_params else None,
                dataset_id=body.dataset_id,
                batch_size=settings.query_fetchmany_batch_size,
            )
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
            "row_count": len(items),
        }

    budget = get_query_budget()

    async def _budgeted_execute() -> dict[str, object]:
        nonlocal queue_wait_ms, execution_ms
        async with budget.acquire() as _qwms:
            queue_wait_ms = _qwms
            result_inner, exec_ms = await budget.run_with_budget(request, _execute)
            execution_ms = exec_ms
        return result_inner

    if settings.cache_enabled:
        cache = await get_query_cache()
        cache_key = build_cache_key(
            "tuples",
            body.dataset_id,
            body.date_range.model_dump(),
            body.query.model_dump(),
        )
        result, meta = await cache.get_or_set(
            cache_key,
            _budgeted_execute,
            ttl_seconds=settings.cache_ttl_seconds,
            max_item_bytes=settings.cache_max_item_bytes,
        )
        cache_status = meta.cache_status
        cache_source = meta.cache_source
    else:
        result = await _budgeted_execute()

    duration_ms = result.get("duration_ms", 0.0)
    resp_body = result["response"]
    time_filter_applied, time_filter_column = _time_filter_metadata(body.dataset_id)
    logger.info(
        "tuples query executed",
        extra={
            "dataset_id": body.dataset_id,
            "endpoint": "tuples",
            "duration_ms": round(duration_ms, 2),
            "row_count": result.get("row_count", 0),
            "total_count": resp_body["total_count"],
            "cache_status": cache_status,
            "cache_source": cache_source,
            "queue_wait_ms": round(queue_wait_ms, 2),
            "execution_ms": round(execution_ms, 2),
            "time_filter_applied": time_filter_applied,
            "time_filter_column": time_filter_column,
        },
    )

    return TuplesResponse(
        total_count=resp_body["total_count"],
        items=[TupleItem(**item) for item in resp_body["items"]],
        paging=PagingResponse(**resp_body["paging"]),
    )


@router.post("/cells", response_model=CellsResponse)
@limiter.limit(lambda: get_settings().rate_limit_query)
async def post_query_cells(body: QueryCellsRequest, request: Request, response: Response, _api_key: str = Depends(require_api_key)) -> CellsResponse:
    """POST /query/cells: fetch aggregated cell values grouped by dimensions."""
    _apply_client_request_id(body, request)
    queue_wait_ms = 0.0
    execution_ms = 0.0
    settings = get_settings()
    if datasets.get_schema(body.dataset_id) is None:
        raise DatasetNotFoundError(body.dataset_id)

    schema_fields = datasets.get_schema_field_names(body.dataset_id)
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
        rows = await db_manager.execute_sql_fetchmany_async(
            sql,
            tuple(params) if params else None,
            dataset_id=body.dataset_id,
            batch_size=settings.query_fetchmany_batch_size,
        )
        duration_ms = (time.perf_counter() - start) * 1000
        cells = [{"row_index": i, "values": {str(k): v for k, v in enumerate(row)}} for i, row in enumerate(rows)]
        return {"response": {"cells": cells}, "duration_ms": duration_ms, "row_count": len(rows)}

    budget = get_query_budget()

    async def _budgeted_execute() -> dict[str, object]:
        nonlocal queue_wait_ms, execution_ms
        async with budget.acquire() as _qwms:
            queue_wait_ms = _qwms
            result_inner, exec_ms = await budget.run_with_budget(request, _execute)
            execution_ms = exec_ms
        return result_inner

    if settings.cache_enabled:
        cache = await get_query_cache()
        cache_key = build_cache_key(
            "cells",
            body.dataset_id,
            body.date_range.model_dump(),
            body.query.model_dump(),
        )
        ttl = max(1.0, settings.cache_ttl_seconds / 2) if settings.cache_ttl_seconds else settings.cache_ttl_seconds
        max_item = settings.cache_max_item_bytes // 2 if settings.cache_max_item_bytes else settings.cache_max_item_bytes
        result, meta = await cache.get_or_set(
            cache_key,
            _budgeted_execute,
            ttl_seconds=ttl,
            max_item_bytes=max_item,
        )
        cache_status = meta.cache_status
        cache_source = meta.cache_source
    else:
        result = await _budgeted_execute()

    duration_ms = result.get("duration_ms", 0.0)
    time_filter_applied, time_filter_column = _time_filter_metadata(body.dataset_id)

    logger.info(
        "cells query executed",
        extra={
            "dataset_id": body.dataset_id,
            "endpoint": "cells",
            "duration_ms": round(duration_ms, 2),
            "row_count": result.get("row_count", 0),
            "cache_status": cache_status,
            "cache_source": cache_source,
            "queue_wait_ms": round(queue_wait_ms, 2),
            "execution_ms": round(execution_ms, 2),
            "time_filter_applied": time_filter_applied,
            "time_filter_column": time_filter_column,
        },
    )

    return CellsResponse(cells=result["response"]["cells"])


@router.post("/picklist", response_model=PicklistResponse)
@limiter.limit(lambda: get_settings().rate_limit_query)
async def post_query_picklist(body: QueryPicklistRequest, request: Request, response: Response, _api_key: str = Depends(require_api_key)) -> PicklistResponse:
    """POST /query/picklist: fetch distinct values for a field (filter UI)."""
    _apply_client_request_id(body, request)
    queue_wait_ms = 0.0
    execution_ms = 0.0
    settings = get_settings()
    if datasets.get_schema(body.dataset_id) is None:
        raise DatasetNotFoundError(body.dataset_id)

    schema_fields = datasets.get_schema_field_names(body.dataset_id)
    paging = body.query.paging or PagingSpec(limit=settings.picklist_default_limit, offset=0)
    limit = paging.limit
    offset = paging.offset

    cache_status = "disabled"
    cache_source = "compute"

    async def _execute() -> dict[str, object]:
        start = time.perf_counter()
        sql, params = build_picklist_sql(body.dataset_id, body.query, body.date_range, schema_fields)
        rows = await db_manager.execute_sql_fetchmany_async(
            sql,
            tuple(params) if params else None,
            dataset_id=body.dataset_id,
            batch_size=settings.query_fetchmany_batch_size,
        )
        if rows:
            total_count = int(rows[0][-1])
            values = [{"value": str(row[0]), "label": str(row[0])} for row in rows]
        else:
            total_count = 0
            values = []

        if total_count == 0 and paging.offset > 0:
            count_sql, count_params = build_picklist_count_sql(body.dataset_id, body.query, body.date_range, schema_fields)
            count_rows = await db_manager.execute_sql_fetchmany_async(
                count_sql,
                tuple(count_params) if count_params else None,
                dataset_id=body.dataset_id,
                batch_size=settings.query_fetchmany_batch_size,
            )
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

    budget = get_query_budget()

    async def _budgeted_execute() -> dict[str, object]:
        nonlocal queue_wait_ms, execution_ms
        async with budget.acquire() as _qwms:
            queue_wait_ms = _qwms
            result_inner, exec_ms = await budget.run_with_budget(request, _execute)
            execution_ms = exec_ms
        return result_inner

    if settings.cache_enabled:
        cache = await get_query_cache()
        cache_key = build_cache_key(
            "picklist",
            body.dataset_id,
            body.date_range.model_dump(),
            body.query.model_dump(),
        )
        result, meta = await cache.get_or_set(
            cache_key,
            _budgeted_execute,
            ttl_seconds=settings.cache_ttl_seconds,
            max_item_bytes=settings.cache_max_item_bytes,
        )
        cache_status = meta.cache_status
        cache_source = meta.cache_source
    else:
        result = await _budgeted_execute()

    duration_ms = result.get("duration_ms", 0.0)
    resp_body = result["response"]
    time_filter_applied, time_filter_column = _time_filter_metadata(body.dataset_id)
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
            "queue_wait_ms": round(queue_wait_ms, 2),
            "execution_ms": round(execution_ms, 2),
            "time_filter_applied": time_filter_applied,
            "time_filter_column": time_filter_column,
        },
    )

    return PicklistResponse(
        total_count=resp_body["total_count"],
        values=resp_body["values"],
        paging=PagingResponse(**resp_body["paging"]),
    )
