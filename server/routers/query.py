"""
Query endpoints: /query/tuples, /query/cells, /query/picklist (tech spec).
"""

from fastapi import APIRouter, HTTPException

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

router = APIRouter(prefix="/query", tags=["query"])


@router.post("/tuples", response_model=TuplesResponse)
async def post_query_tuples(body: QueryTuplesRequest) -> TuplesResponse:
    """POST /query/tuples: fetch distinct dimension values for one axis."""
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise HTTPException(status_code=404, detail=f"Dataset not found: {body.dataset_id}")

    schema_fields = datasets.get_schema_field_names(body.dataset_id)
    paging = body.query.paging
    limit = paging.limit if paging else 200
    offset = paging.offset if paging else 0

    sql, params = build_tuples_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    rows = await db_manager.execute_sql_async(sql, tuple(params) if params else None)

    count_sql, count_params = build_tuples_count_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    count_rows = await db_manager.execute_sql_async(count_sql, tuple(count_params) if count_params else None)
    total_count = count_rows[0][0] if count_rows else 0

    items = [TupleItem(values=list(row)) for row in rows]
    return TuplesResponse(
        total_count=total_count,
        items=items,
        paging=PagingResponse(limit=limit, offset=offset, returned=len(items)),
    )


@router.post("/cells", response_model=CellsResponse)
async def post_query_cells(body: QueryCellsRequest) -> CellsResponse:
    """POST /query/cells: fetch aggregated cell values grouped by dimensions."""
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise HTTPException(status_code=404, detail=f"Dataset not found: {body.dataset_id}")

    schema_fields = datasets.get_schema_field_names(body.dataset_id)

    sql, params = build_cells_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    rows = await db_manager.execute_sql_async(sql, tuple(params) if params else None)

    cells = []
    for i, row in enumerate(rows):
        cells.append({"row_index": i, "values": {str(k): v for k, v in enumerate(row)}})
    return CellsResponse(cells=cells)


@router.post("/picklist", response_model=PicklistResponse)
async def post_query_picklist(body: QueryPicklistRequest) -> PicklistResponse:
    """POST /query/picklist: fetch distinct values for a field (filter UI)."""
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise HTTPException(status_code=404, detail=f"Dataset not found: {body.dataset_id}")

    schema_fields = datasets.get_schema_field_names(body.dataset_id)
    paging = body.query.paging
    limit = paging.limit if paging else 100
    offset = paging.offset if paging else 0

    sql, params = build_picklist_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    rows = await db_manager.execute_sql_async(sql, tuple(params) if params else None)

    count_sql, count_params = build_picklist_count_sql(body.dataset_id, body.query, body.date_range, schema_fields)
    count_rows = await db_manager.execute_sql_async(count_sql, tuple(count_params) if count_params else None)
    total_count = count_rows[0][0] if count_rows else 0

    values = [{"value": str(row[0]), "label": str(row[0])} for row in rows]
    return PicklistResponse(
        total_count=total_count,
        values=values,
        paging=PagingResponse(limit=limit, offset=offset, returned=len(values)),
    )
