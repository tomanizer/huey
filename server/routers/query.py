"""
Query endpoints under /api/v1/datasets/{dataset_id}/query/*.
"""

import logging
import time

from fastapi import APIRouter, Depends, Request, Response

from server import datasets
from server.auth import require_api_key
from server.cache import build_cache_key, get_query_cache
from server.config import get_settings
from server.derivations import get_output_name
from server.engine import QueryCancelHandle, db_manager
from server.errors import (
    CellsWindowTooLargeError,
    DatasetNotFoundError,
    DateRangeNotSupportedError,
    ValidationAppError,
)
from server.models import (
    CellsQueryBody,
    CellsResponse,
    MetaResponse,
    PagingResponse,
    PagingSpec,
    PicklistQueryBody,
    PicklistResponse,
    QueryCellsRequest,
    QueryPicklistRequest,
    QueryTuplesRequest,
    TupleItem,
    TuplesQueryBody,
    TuplesResponse,
    WindowSpec,
)
from server.query_budget import get_query_budget
from server.query_builder import (
    build_cells_sql,
    build_picklist_count_sql,
    build_picklist_sql,
    build_tuples_count_sql,
    build_tuples_sql,
    validate_cells_query_fields,
)
from server.rate_limit import limiter
from server.request_context import get_request_id

logger = logging.getLogger("query_service.query")
router = APIRouter(prefix="/query", tags=["query"])


def _path_dataset_id(request: Request) -> str:
    """Return the required dataset id from the v1 route path."""
    value = request.path_params.get("dataset_id")
    if isinstance(value, str) and value:
        return value
    raise RuntimeError("v1 query routes require a dataset_id path parameter")


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


def _create_meta_response(result: dict[str, object], cache_status: str) -> MetaResponse:
    """Build per-response query metadata outside cached payloads."""
    return MetaResponse(
        execution_ms=round(float(result.get("duration_ms", 0.0)), 2),
        cache_status=cache_status,
        request_id=get_request_id() or None,
    )


def _ensure_date_range_supported(dataset_id: str, date_range) -> None:
    if (
        date_range is not None
        and datasets.get_time_dimension(dataset_id) is None
        and "date" not in datasets.get_schema_field_names(dataset_id)
    ):
        raise DateRangeNotSupportedError(dataset_id)


async def _execute_with_budget(request: Request, coro_factory, cancel_fn=None):
    """Run a SQL coroutine with query budget enforcement."""
    budget = get_query_budget()
    async with budget.acquire() as queue_wait_ms:
        result, execution_ms = await budget.run_with_budget(request, coro_factory, cancel_fn=cancel_fn)
    return result, queue_wait_ms, execution_ms


def _default_measure_alias(field: str, aggregation: str, alias: str | None) -> str:
    if alias:
        return alias
    return f"{aggregation.lower()}_{field}"


def _validate_cells_measure_aliases(measures) -> None:
    aliases = [_default_measure_alias(measure.field, measure.aggregation, measure.alias) for measure in measures]
    reserved = {"row", "col"}
    duplicates = {alias for alias in aliases if aliases.count(alias) > 1}
    reserved_hits = reserved.intersection(aliases)
    if not duplicates and not reserved_hits:
        return

    errors = []
    for index, alias in enumerate(aliases):
        if alias in duplicates:
            errors.append(
                {
                    "loc": ["body", "axes", "measures", index, "alias"],
                    "msg": f"Duplicate measure alias: {alias}",
                    "type": "value_error.duplicate_alias",
                }
            )
        if alias in reserved_hits:
            errors.append(
                {
                    "loc": ["body", "axes", "measures", index, "alias"],
                    "msg": f"Reserved measure alias: {alias}",
                    "type": "value_error.reserved_alias",
                }
            )
    raise ValidationAppError(errors)


async def _fetch_axis_window(
    request: Request,
    dataset_id: str,
    axis_items: list[object],
    filters,
    date_range,
    schema_fields: set[str],
    limit: int | None,
    offset: int | None,
    cancel_handle: QueryCancelHandle | None = None,
) -> tuple[list[dict[str, object]], int]:
    field_names = [
        get_output_name(item.field, getattr(item, "derivation", None), getattr(item, "alias", None))
        for item in axis_items
    ]
    if not field_names:
        total = 1
        if offset and offset > 0:
            return [], total
        if limit == 0:
            return [], total
        return [{}], total

    query = TuplesQueryBody(
        fields=[
            {
                "field": item.field,
                "derivation": getattr(item, "derivation", None),
                "alias": getattr(item, "alias", None),
                "sort": "ASC",
            }
            for item in axis_items
        ],
        filters=filters,
        paging=PagingSpec(limit=limit or get_settings().tuples_default_limit, offset=offset or 0),
    )
    sql, params = build_tuples_sql(dataset_id, query, date_range, schema_fields)
    rows, _, _ = await _execute_with_budget(
        request,
        lambda: db_manager.execute_sql_async(
            sql,
            tuple(params) if params else None,
            dataset_id=dataset_id,
            cancel_handle=cancel_handle,
        ),
        cancel_fn=cancel_handle.cancel if cancel_handle is not None else None,
    )

    if rows:
        total = int(rows[0][-1])
    else:
        total = 0
        if offset:
            count_sql, count_params = build_tuples_count_sql(dataset_id, query, date_range, schema_fields)
            count_rows = await db_manager.execute_sql_async(
                count_sql,
                tuple(count_params) if count_params else None,
                dataset_id=dataset_id,
            )
            if count_rows:
                total = int(count_rows[0][0])

    members = [
        {field_name: row[index] for index, field_name in enumerate(field_names)}
        for row in rows
    ]
    return members, total


@router.post("/tuples", response_model=TuplesResponse, response_model_exclude_none=True)
@limiter.limit(lambda: get_settings().rate_limit_query)
async def post_query_tuples(
    request: Request,
    body: QueryTuplesRequest,
    response: Response,
    _api_key: str = Depends(require_api_key),
) -> TuplesResponse:
    """POST /api/v1/datasets/{dataset_id}/query/tuples."""
    dataset_id = _path_dataset_id(request)
    settings = get_settings()
    if datasets.get_schema(dataset_id) is None:
        raise DatasetNotFoundError(dataset_id)
    _ensure_date_range_supported(dataset_id, body.date_range)

    query = TuplesQueryBody(
        fields=body.fields,
        filters=body.filters,
        paging=body.paging,
    )

    schema_fields = datasets.get_schema_field_names(dataset_id)
    paging = query.paging or PagingSpec(limit=settings.tuples_default_limit, offset=0)

    cache_status = "disabled"
    cache_source = "compute"

    cancel_handle = QueryCancelHandle()

    async def _execute() -> dict[str, object]:
        start = time.perf_counter()
        sql, params = build_tuples_sql(dataset_id, query, body.date_range, schema_fields)

        async def _run_query():
            return await db_manager.execute_sql_async(
                sql,
                tuple(params) if params else None,
                dataset_id=dataset_id,
                cancel_handle=cancel_handle,
            )

        rows, queue_wait_ms, execution_ms = await _execute_with_budget(request, _run_query, cancel_fn=cancel_handle.cancel)
        field_names = [
            get_output_name(field.field, getattr(field, "derivation", None), getattr(field, "alias", None))
            for field in (query.fields or [])
        ]
        if rows:
            total_count = int(rows[0][-1])
            items = [
                {field_name: row[index] for index, field_name in enumerate(field_names)}
                for row in rows
            ]
        else:
            total_count = 0
            items = []

        if total_count == 0 and paging.offset > 0:
            count_sql, count_params = build_tuples_count_sql(dataset_id, query, body.date_range, schema_fields)
            count_cancel_handle = QueryCancelHandle()
            count_rows = await db_manager.execute_sql_async(
                count_sql,
                tuple(count_params) if count_params else None,
                dataset_id=dataset_id,
                cancel_handle=count_cancel_handle,
            )
            if count_rows:
                total_count = int(count_rows[0][0])

        duration_ms = (time.perf_counter() - start) * 1000
        return {
            "response": {
                "total_count": total_count,
                "items": items,
                "paging": {"limit": paging.limit, "offset": paging.offset, "returned": len(items)},
            },
            "duration_ms": duration_ms,
            "row_count": len(items),
            "queue_wait_ms": queue_wait_ms,
            "execution_ms": execution_ms,
        }

    if getattr(settings, "cache_enabled", False):
        cache = await get_query_cache()
        data_version_token = datasets.get_data_version_token(dataset_id, body.date_range)
        cache_key = build_cache_key(
            "tuples",
            dataset_id,
            body.date_range.model_dump() if body.date_range is not None else None,
            query.model_dump(),
            fact_version_token=data_version_token,
        )
        result, meta = await cache.get_or_set(
            cache_key,
            _execute,
            ttl_seconds=settings.cache_ttl_seconds,
            max_item_bytes=settings.cache_max_item_bytes,
            endpoint="tuples",
        )
        cache_status = meta.cache_status
        cache_source = meta.cache_source
    else:
        result = await _execute()

    resp_body = result["response"]
    time_filter_applied, time_filter_column = _time_filter_metadata(dataset_id)
    logger.info(
        "tuples query executed",
        extra={
            "dataset_id": dataset_id,
            "endpoint": "tuples",
            "duration_ms": round(result.get("duration_ms", 0.0), 2),
            "row_count": result.get("row_count", 0),
            "total_count": resp_body["total_count"],
            "cache_status": cache_status,
            "cache_source": cache_source,
            "queue_wait_ms": round(result.get("queue_wait_ms", 0.0), 2),
            "execution_ms": round(result.get("execution_ms", 0.0), 2),
            "time_filter_applied": time_filter_applied,
            "time_filter_column": time_filter_column,
        },
    )

    return TuplesResponse(
        total_count=resp_body["total_count"],
        items=[TupleItem(**item) for item in resp_body["items"]],
        paging=PagingResponse(**resp_body["paging"]),
        meta=_create_meta_response(result, cache_status),
    )


@router.post("/cells", response_model=CellsResponse)
@limiter.limit(lambda: get_settings().rate_limit_query)
async def post_query_cells(
    request: Request,
    body: QueryCellsRequest,
    response: Response,
    _api_key: str = Depends(require_api_key),
) -> CellsResponse:
    """POST /api/v1/datasets/{dataset_id}/query/cells."""
    dataset_id = _path_dataset_id(request)
    settings = get_settings()
    if datasets.get_schema(dataset_id) is None:
        raise DatasetNotFoundError(dataset_id)
    _ensure_date_range_supported(dataset_id, body.date_range)

    query = CellsQueryBody(
        rows=WindowSpec(start_index=body.window.rows.offset, count=body.window.rows.limit) if body.window and body.window.rows else None,
        columns=WindowSpec(start_index=body.window.columns.offset, count=body.window.columns.limit) if body.window and body.window.columns else None,
        axes=body.axes,
        filters=body.filters,
    )

    schema_fields = datasets.get_schema_field_names(dataset_id)
    validate_cells_query_fields(query, schema_fields)
    row_window = query.rows
    col_window = query.columns
    measures = list((query.axes.measures if query.axes else []) or [])
    _validate_cells_measure_aliases(measures)

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

    cancel_handle = QueryCancelHandle()

    async def _execute() -> dict[str, object]:
        start = time.perf_counter()
        effective_max = settings.max_cells_per_response
        axes = query.axes or CellsQueryBody().axes
        row_items = list(axes.rows if axes else [])
        col_items = list(axes.columns if axes else [])
        row_fields = [get_output_name(item.field, item.derivation, item.alias) for item in row_items]
        col_fields = [get_output_name(item.field, item.derivation, item.alias) for item in col_items]
        measures = list(axes.measures if axes else [])
        row_window_limit = body.window.rows.limit if body.window and body.window.rows else effective_max
        row_window_offset = body.window.rows.offset if body.window and body.window.rows else 0
        col_window_limit = body.window.columns.limit if body.window and body.window.columns else effective_max
        col_window_offset = body.window.columns.offset if body.window and body.window.columns else 0

        rows_payload, row_total = await _fetch_axis_window(
            request,
            dataset_id,
            row_items,
            body.filters,
            body.date_range,
            schema_fields,
            row_window_limit,
            row_window_offset,
            cancel_handle,
        )
        columns_payload, col_total = await _fetch_axis_window(
            request,
            dataset_id,
            col_items,
            body.filters,
            body.date_range,
            schema_fields,
            col_window_limit,
            col_window_offset,
            cancel_handle,
        )
        sql, params = build_cells_sql(
            dataset_id, query, body.date_range, schema_fields, max_cells=effective_max + 1
        )

        async def _run_query():
            return await db_manager.execute_sql_async(
                sql,
                tuple(params) if params else None,
                dataset_id=dataset_id,
                cancel_handle=cancel_handle,
            )

        rows, queue_wait_ms, execution_ms = await _execute_with_budget(request, _run_query, cancel_fn=cancel_handle.cancel)
        duration_ms = (time.perf_counter() - start) * 1000
        if len(rows) > effective_max:
            logger.warning(
                "cells query cap exceeded",
                extra={
                    "dataset_id": dataset_id,
                    "endpoint": "cells",
                    "cap": effective_max,
                    "returned_count": len(rows),
                    "min_result_count": effective_max + 1,
                },
            )
            raise CellsWindowTooLargeError(
                "Cells query result exceeds maximum cells per response",
                {
                    "max_cells_per_response": effective_max,
                    "returned_count": len(rows),
                    "min_result_count": effective_max + 1,
                },
            )
        measure_aliases = [
            _default_measure_alias(measure.field, measure.aggregation, measure.alias)
            for measure in measures
        ]
        row_lookup = {
            tuple(row_payload.get(field_name) for field_name in row_fields): index
            for index, row_payload in enumerate(rows_payload)
        }
        col_lookup = {
            tuple(col_payload.get(field_name) for field_name in col_fields): index
            for index, col_payload in enumerate(columns_payload)
        }
        cells = []
        for row in rows:
            row_key = tuple(row[index] for index in range(min(len(row_fields), len(row))))
            if len(row_key) != len(row_fields):
                row_key = tuple(rows_payload[0].get(field_name) for field_name in row_fields) if rows_payload else tuple()

            col_start = len(row_fields)
            col_key = tuple(
                row[col_start + index]
                for index in range(len(col_fields))
                if (col_start + index) < len(row)
            )
            if len(col_key) != len(col_fields):
                col_key = tuple(columns_payload[0].get(field_name) for field_name in col_fields) if columns_payload else tuple()
            row_index = row_lookup.get(row_key, 0)
            col_index = col_lookup.get(col_key, 0)
            payload = {"row": row_index, "col": col_index}
            non_null_measure = False
            measure_offset = len(row_fields) + len(col_fields)
            fallback_measure_offset = max(0, len(row) - len(measure_aliases))
            for index, alias in enumerate(measure_aliases):
                value_index = measure_offset + index
                if value_index >= len(row):
                    value_index = fallback_measure_offset + index
                value = row[value_index] if value_index < len(row) else None
                if value is not None:
                    non_null_measure = True
                payload[alias] = value
            if non_null_measure or not measure_aliases:
                cells.append(payload)
        return {
            "response": {
                "rows": rows_payload,
                "columns": columns_payload,
                "cells": cells,
                "window": {
                    "rows": {
                        "offset": row_window_offset,
                        "limit": row_window_limit or row_total,
                        "total": row_total,
                    },
                    "columns": {
                        "offset": col_window_offset,
                        "limit": col_window_limit or col_total,
                        "total": col_total,
                    },
                },
            },
            "duration_ms": duration_ms,
            "row_count": len(rows),
            "queue_wait_ms": queue_wait_ms,
            "execution_ms": execution_ms,
        }

    if getattr(settings, "cache_enabled", False):
        cache = await get_query_cache()
        data_version_token = datasets.get_data_version_token(dataset_id, body.date_range)
        cache_key = build_cache_key(
            "cells",
            dataset_id,
            body.date_range.model_dump() if body.date_range is not None else None,
            query.model_dump(),
            fact_version_token=data_version_token,
        )
        ttl = max(1.0, settings.cache_ttl_seconds / 2) if settings.cache_ttl_seconds else settings.cache_ttl_seconds
        max_item = settings.cache_max_item_bytes // 2 if settings.cache_max_item_bytes else settings.cache_max_item_bytes
        result, meta = await cache.get_or_set(
            cache_key,
            _execute,
            ttl_seconds=ttl,
            max_item_bytes=max_item,
            endpoint="cells",
        )
        cache_status = meta.cache_status
        cache_source = meta.cache_source
    else:
        result = await _execute()

    time_filter_applied, time_filter_column = _time_filter_metadata(dataset_id)
    logger.info(
        "cells query executed",
        extra={
            "dataset_id": dataset_id,
            "endpoint": "cells",
            "duration_ms": round(result.get("duration_ms", 0.0), 2),
            "row_count": result.get("row_count", 0),
            "cache_status": cache_status,
            "cache_source": cache_source,
            "queue_wait_ms": round(result.get("queue_wait_ms", 0.0), 2),
            "execution_ms": round(result.get("execution_ms", 0.0), 2),
            "time_filter_applied": time_filter_applied,
            "time_filter_column": time_filter_column,
        },
    )

    response_payload = dict(result["response"])
    response_payload["meta"] = _create_meta_response(result, cache_status)
    return CellsResponse(**response_payload)


@router.post("/members", response_model=PicklistResponse)
@limiter.limit(lambda: get_settings().rate_limit_query)
async def post_query_members(
    request: Request,
    body: QueryPicklistRequest,
    response: Response,
    _api_key: str = Depends(require_api_key),
) -> PicklistResponse:
    """POST /api/v1/datasets/{dataset_id}/query/members."""
    dataset_id = _path_dataset_id(request)
    settings = get_settings()
    if datasets.get_schema(dataset_id) is None:
        raise DatasetNotFoundError(dataset_id)
    _ensure_date_range_supported(dataset_id, body.date_range)

    query = PicklistQueryBody(
        field=body.field,
        derivation=body.derivation,
        alias=body.alias,
        search=body.search,
        filters=body.filters,
        paging=body.paging,
    )

    schema_fields = datasets.get_schema_field_names(dataset_id)
    paging = query.paging or PagingSpec(limit=settings.picklist_default_limit, offset=0)

    cache_status = "disabled"
    cache_source = "compute"
    dim_version_token: str | None = None  # Set when cache_enabled for logging

    cancel_handle = QueryCancelHandle()

    async def _execute() -> dict[str, object]:
        start = time.perf_counter()
        sql, params = build_picklist_sql(dataset_id, query, body.date_range, schema_fields)

        async def _run_query():
            return await db_manager.execute_sql_async(
                sql,
                tuple(params) if params else None,
                dataset_id=dataset_id,
                cancel_handle=cancel_handle,
            )

        rows, queue_wait_ms, execution_ms = await _execute_with_budget(request, _run_query, cancel_fn=cancel_handle.cancel)
        if rows:
            total_count = int(rows[0][-1])
            items = [{"value": row[0], "count": int(row[1])} for row in rows]
        else:
            total_count = 0
            items = []

        if total_count == 0 and paging.offset > 0:
            count_sql, count_params = build_picklist_count_sql(dataset_id, query, body.date_range, schema_fields)
            count_cancel_handle = QueryCancelHandle()
            count_rows = await db_manager.execute_sql_async(
                count_sql,
                tuple(count_params) if count_params else None,
                dataset_id=dataset_id,
                cancel_handle=count_cancel_handle,
            )
            if count_rows:
                total_count = int(count_rows[0][0])

        duration_ms = (time.perf_counter() - start) * 1000
        return {
            "response": {
                "field": get_output_name(query.field, query.derivation, query.alias) if query.field else None,
                "total_count": total_count,
                "items": items,
                "paging": {"limit": paging.limit, "offset": paging.offset, "returned": len(items)},
            },
            "duration_ms": duration_ms,
            "row_count": len(items),
            "queue_wait_ms": queue_wait_ms,
            "execution_ms": execution_ms,
        }

    if getattr(settings, "cache_enabled", False):
        cache = await get_query_cache()
        dim_version_token = datasets.get_dim_version_token(dataset_id)
        cache_key = build_cache_key(
            "members",
            dataset_id,
            body.date_range.model_dump() if body.date_range is not None else None,
            query.model_dump(),
            dim_version_token=dim_version_token,
        )
        result, meta = await cache.get_or_set(
            cache_key,
            _execute,
            ttl_seconds=float(settings.dim_cache_ttl_seconds),
            max_item_bytes=settings.cache_max_item_bytes,
            stale_ttl_seconds=float(settings.dim_stale_ttl_seconds),
            endpoint="picklist",
        )
        cache_status = meta.cache_status
        cache_source = meta.cache_source
    else:
        result = await _execute()

    resp_body = result["response"]
    time_filter_applied, time_filter_column = _time_filter_metadata(dataset_id)
    logger.info(
        "members query executed",
        extra={
            "dataset_id": dataset_id,
            "endpoint": "members",
            "duration_ms": round(result.get("duration_ms", 0.0), 2),
            "row_count": result.get("row_count", 0),
            "total_count": resp_body["total_count"],
            "cache_status": cache_status,
            "cache_source": cache_source,
            "dim_version_token": dim_version_token,
            "queue_wait_ms": round(result.get("queue_wait_ms", 0.0), 2),
            "execution_ms": round(result.get("execution_ms", 0.0), 2),
            "time_filter_applied": time_filter_applied,
            "time_filter_column": time_filter_column,
        },
    )

    return PicklistResponse(
        field=resp_body["field"],
        total_count=resp_body["total_count"],
        items=resp_body["items"],
        paging=PagingResponse(**resp_body["paging"]),
        meta=_create_meta_response(result, cache_status),
    )
