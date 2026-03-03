"""
Query endpoints: /query/tuples, /query/cells, /query/picklist (tech spec).
"""

import logging
import time

from fastapi import APIRouter, HTTPException, Request

from server import datasets
from server.engine import db_manager
from server.models import (
    CellsResponse,
    PagingResponse,
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
from server.request_context import set_request_id

logger = logging.getLogger("query_service.query")
router = APIRouter(prefix="/query", tags=["query"])


def _apply_client_request_id(body, request: Request) -> None:
    """Override correlation ID with client_context.request_id when provided."""
    if body.client_context and body.client_context.request_id:
        rid = body.client_context.request_id
        set_request_id(rid)
        request.state.request_id = rid


@router.post("/tuples", response_model=TuplesResponse)
async def post_query_tuples(body: QueryTuplesRequest, request: Request) -> TuplesResponse:
    """POST /query/tuples: fetch distinct dimension values for one axis."""
    _apply_client_request_id(body, request)
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise HTTPException(status_code=404, detail=f"Dataset not found: {body.dataset_id}")

    schema_fields = datasets.get_schema_field_names(body.dataset_id)
    paging = body.query.paging
    limit = paging.limit if paging else 200
    offset = paging.offset if paging else 0

    start = time.perf_counter()
    sql, params = build_tuples_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    rows = await db_manager.execute_sql_async(sql, tuple(params) if params else None)

    count_sql, count_params = build_tuples_count_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    count_rows = await db_manager.execute_sql_async(count_sql, tuple(count_params) if count_params else None)
    total_count = count_rows[0][0] if count_rows else 0
    duration_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "tuples query executed",
        extra={
            "dataset_id": body.dataset_id,
            "endpoint": "tuples",
            "duration_ms": round(duration_ms, 2),
            "row_count": len(rows),
            "total_count": total_count,
        },
    )

    items = [TupleItem(values=list(row)) for row in rows]
    return TuplesResponse(
        total_count=total_count,
        items=items,
        paging=PagingResponse(limit=limit, offset=offset, returned=len(items)),
    )


@router.post("/cells", response_model=CellsResponse)
async def post_query_cells(body: QueryCellsRequest, request: Request) -> CellsResponse:
    """POST /query/cells: fetch aggregated cell values grouped by dimensions."""
    _apply_client_request_id(body, request)
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise HTTPException(status_code=404, detail=f"Dataset not found: {body.dataset_id}")

    schema_fields = datasets.get_schema_field_names(body.dataset_id)

    start = time.perf_counter()
    sql, params = build_cells_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    rows = await db_manager.execute_sql_async(sql, tuple(params) if params else None)
    duration_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "cells query executed",
        extra={
            "dataset_id": body.dataset_id,
            "endpoint": "cells",
            "duration_ms": round(duration_ms, 2),
            "row_count": len(rows),
        },
    )

    cells = []
    for i, row in enumerate(rows):
        cells.append({"row_index": i, "values": {str(k): v for k, v in enumerate(row)}})
    return CellsResponse(cells=cells)


@router.post("/picklist", response_model=PicklistResponse)
async def post_query_picklist(body: QueryPicklistRequest, request: Request) -> PicklistResponse:
    """POST /query/picklist: fetch distinct values for a field (filter UI)."""
    _apply_client_request_id(body, request)
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise HTTPException(status_code=404, detail=f"Dataset not found: {body.dataset_id}")

    schema_fields = datasets.get_schema_field_names(body.dataset_id)
    paging = body.query.paging
    limit = paging.limit if paging else 100
    offset = paging.offset if paging else 0

    start = time.perf_counter()
    sql, params = build_picklist_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    rows = await db_manager.execute_sql_async(sql, tuple(params) if params else None)

    count_sql, count_params = build_picklist_count_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    count_rows = await db_manager.execute_sql_async(count_sql, tuple(count_params) if count_params else None)
    total_count = count_rows[0][0] if count_rows else 0
    duration_ms = (time.perf_counter() - start) * 1000

    logger.info(
        "picklist query executed",
        extra={
            "dataset_id": body.dataset_id,
            "endpoint": "picklist",
            "duration_ms": round(duration_ms, 2),
            "row_count": len(rows),
            "total_count": total_count,
        },
    )

    values = [{"value": str(row[0]), "label": str(row[0])} for row in rows]
    return PicklistResponse(
        total_count=total_count,
        values=values,
        paging=PagingResponse(limit=limit, offset=offset, returned=len(values)),
    )
