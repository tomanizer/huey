"""
Query endpoints: /query/tuples, /query/cells, /query/picklist (tech spec).
"""

from fastapi import APIRouter, HTTPException

from server import datasets
from server.models import (
    CellsResponse,
    DateRangeRange,
    DateRangeSingle,
    PagingResponse,
    PicklistResponse,
    QueryCellsRequest,
    QueryPicklistRequest,
    QueryTuplesRequest,
    TuplesResponse,
)

router = APIRouter(prefix="/query", tags=["query"])


def _get_date_str(date_range: DateRangeSingle | DateRangeRange) -> str:
    """Extract a single date string for partition path."""
    if isinstance(date_range, DateRangeSingle):
        return date_range.date
    return date_range.start


@router.post("/tuples", response_model=TuplesResponse)
async def post_query_tuples(body: QueryTuplesRequest) -> TuplesResponse:
    """
    POST /query/tuples: fetch row or column headers (tuples) for one axis.
    Basic implementation: validates request, returns empty result or stub.
    """
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise HTTPException(status_code=404, detail=f"Dataset not found: {body.dataset_id}")

    paging = body.query.paging
    limit = paging.limit if paging else 200
    offset = paging.offset if paging else 0

    return TuplesResponse(
        total_count=0,
        items=[],
        paging=PagingResponse(limit=limit, offset=offset, returned=0),
    )


@router.post("/cells", response_model=CellsResponse)
async def post_query_cells(body: QueryCellsRequest) -> CellsResponse:
    """
    POST /query/cells: fetch cell values for a window of row/column tuples.
    Basic implementation: validates request, returns empty cells.
    """
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise HTTPException(status_code=404, detail=f"Dataset not found: {body.dataset_id}")

    return CellsResponse(cells=[])


@router.post("/picklist", response_model=PicklistResponse)
async def post_query_picklist(body: QueryPicklistRequest) -> PicklistResponse:
    """
    POST /query/picklist: fetch distinct values for a field (filter UI).
    Basic implementation: validates request, returns empty values.
    """
    schema = datasets.get_schema(body.dataset_id)
    if schema is None:
        raise HTTPException(status_code=404, detail=f"Dataset not found: {body.dataset_id}")

    paging = body.query.paging
    limit = paging.limit if paging else 100
    offset = paging.offset if paging else 0

    return PicklistResponse(
        total_count=0,
        values=[],
        paging=PagingResponse(limit=limit, offset=offset, returned=0),
    )
