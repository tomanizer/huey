"""
Query endpoints: /query/tuples, /query/cells, /query/picklist (tech spec).
"""

import logging
import time

from fastapi import APIRouter, Depends, Request

from server import datasets
from server.config import get_settings
from server.auth import require_api_key
from server.engine import db_manager
from server.errors import DatasetNotFoundError
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
    build_tuples_sql,
    build_tuples_count_sql,
)
from server.query_budget import get_query_budget
from server.request_context import set_request_id

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
async def post_query_tuples(body: QueryTuplesRequest, request: Request, _api_key: str = Depends(require_api_key)) -> TuplesResponse:
    """POST /query/tuples: fetch distinct dimension values for one axis."""
    _apply_client_request_id(body, request)
    settings = get_settings()
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise DatasetNotFoundError(body.dataset_id)

    schema_fields = datasets.get_schema_field_names(body.dataset_id)
    paging = body.query.paging or PagingSpec(limit=settings.tuples_default_limit, offset=0)
    limit = paging.limit
    offset = paging.offset

    start = time.perf_counter()
    query_body = body.query.model_copy(update={"paging": paging})
    sql, params = build_tuples_sql(body.dataset_id, query_body, body.date_range, schema_fields)
    rows, queue_wait_ms, execution_ms = await _execute_with_budget(
        request, lambda: db_manager.execute_sql_async(sql, tuple(params) if params else None),
    )
    if rows:
        total_count = int(rows[0][-1])
        items = [TupleItem(values=list(row[:-1])) for row in rows]
    else:
        total_count = 0
        items = []

    # Fallback to a lightweight count when page is empty (e.g., offset beyond results)
    if total_count == 0 and paging.offset > 0:
        count_sql, count_params = build_tuples_count_sql(body.dataset_id, query_body, body.date_range, schema_fields)
        count_rows, _, _ = await _execute_with_budget(
            request, lambda: db_manager.execute_sql_async(count_sql, tuple(count_params) if count_params else None),
        )
        if count_rows:
            total_count = int(count_rows[0][0])
    duration_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "tuples query executed",
        extra={
            "dataset_id": body.dataset_id,
            "endpoint": "tuples",
            "duration_ms": round(duration_ms, 2),
            "row_count": len(rows),
            "total_count": total_count,
            "queue_wait_ms": round(queue_wait_ms, 2),
            "execution_ms": round(execution_ms, 2),
        },
    )

    return TuplesResponse(
        total_count=total_count,
        items=items,
        paging=PagingResponse(limit=limit, offset=offset, returned=len(items)),
    )


@router.post("/cells", response_model=CellsResponse)
async def post_query_cells(body: QueryCellsRequest, request: Request, _api_key: str = Depends(require_api_key)) -> CellsResponse:
    """POST /query/cells: fetch aggregated cell values grouped by dimensions."""
    _apply_client_request_id(body, request)
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise DatasetNotFoundError(body.dataset_id)

    schema_fields = datasets.get_schema_field_names(body.dataset_id)

    start = time.perf_counter()
    sql, params = build_cells_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    rows, queue_wait_ms, execution_ms = await _execute_with_budget(
        request, lambda: db_manager.execute_sql_async(sql, tuple(params) if params else None),
    )
    duration_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "cells query executed",
        extra={
            "dataset_id": body.dataset_id,
            "endpoint": "cells",
            "duration_ms": round(duration_ms, 2),
            "row_count": len(rows),
            "queue_wait_ms": round(queue_wait_ms, 2),
            "execution_ms": round(execution_ms, 2),
        },
    )

    cells = []
    for i, row in enumerate(rows):
        cells.append({"row_index": i, "values": {str(k): v for k, v in enumerate(row)}})
    return CellsResponse(cells=cells)


@router.post("/picklist", response_model=PicklistResponse)
async def post_query_picklist(body: QueryPicklistRequest, request: Request, _api_key: str = Depends(require_api_key)) -> PicklistResponse:
    """POST /query/picklist: fetch distinct values for a field (filter UI)."""
    _apply_client_request_id(body, request)
    settings = get_settings()
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise DatasetNotFoundError(body.dataset_id)

    schema_fields = datasets.get_schema_field_names(body.dataset_id)
    paging = body.query.paging
    paging = paging or PagingSpec(limit=settings.picklist_default_limit, offset=0)
    limit = paging.limit
    offset = paging.offset

    start = time.perf_counter()
    query_body = body.query.model_copy(update={"paging": paging})
    sql, params = build_picklist_sql(body.dataset_id, query_body, body.date_range, schema_fields)
    rows, queue_wait_ms, execution_ms = await _execute_with_budget(
        request, lambda: db_manager.execute_sql_async(sql, tuple(params) if params else None),
    )
    if rows:
        total_count = int(rows[0][-1])
        values = [{"value": str(row[0]), "label": str(row[0])} for row in rows]
    else:
        total_count = 0
        values = []

    # Fallback to count when page is empty (e.g., offset beyond available values)
    if total_count == 0 and paging.offset > 0:
        count_sql, count_params = build_picklist_count_sql(body.dataset_id, query_body, body.date_range, schema_fields)
        count_rows, _, _ = await _execute_with_budget(
            request, lambda: db_manager.execute_sql_async(count_sql, tuple(count_params) if count_params else None),
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
            "row_count": len(rows),
            "total_count": total_count,
            "queue_wait_ms": round(queue_wait_ms, 2),
            "execution_ms": round(execution_ms, 2),
        },
    )

    return PicklistResponse(
        total_count=total_count,
        values=values,
        paging=PagingResponse(limit=limit, offset=offset, returned=len(values)),
    )
