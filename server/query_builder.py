"""
SQL query generation from typed request models.

Generates parameterized DuckDB SQL for tuples, cells, and picklist queries.
All identifiers are double-quoted to prevent injection; values use parameterized
placeholders.
"""

from typing import Any

from server.models import (
    CellsQueryBody,
    DateRange,
    DateRangeRange,
    DateRangeSingle,
    PicklistQueryBody,
    TupleFilter,
    TuplesQueryBody,
)


def _quote(identifier: str) -> str:
    """Double-quote a SQL identifier, escaping any embedded quotes."""
    return '"' + identifier.replace('"', '""') + '"'


def _build_date_clause(date_range: DateRange, params: list[Any]) -> str:
    """Build a WHERE clause fragment for the date range."""
    if isinstance(date_range, DateRangeSingle):
        params.append(date_range.date)
        return '"date" = ?'
    elif isinstance(date_range, DateRangeRange):
        params.append(date_range.start)
        params.append(date_range.end)
        return '"date" BETWEEN ? AND ?'
    return ""


def _build_filter_clauses(
    filters: list[TupleFilter] | None,
    params: list[Any],
    schema_fields: set[str],
) -> list[str]:
    """Build WHERE clause fragments from user-supplied filters."""
    if not filters:
        return []
    clauses = []
    for f in filters:
        if f.field not in schema_fields:
            continue
        col = _quote(f.field)
        op = f.operator.upper()
        if op == "INCLUDE" and f.values:
            placeholders = ", ".join("?" for _ in f.values)
            clauses.append(f"{col} IN ({placeholders})")
            params.extend(f.values)
        elif op == "EXCLUDE" and f.values:
            placeholders = ", ".join("?" for _ in f.values)
            clauses.append(f"{col} NOT IN ({placeholders})")
            params.extend(f.values)
        elif op == "LIKE" and f.values:
            clauses.append(f"{col} LIKE ?")
            params.append(f.values[0])
        elif op == "BETWEEN" and len(f.values) >= 2:
            clauses.append(f"{col} BETWEEN ? AND ?")
            params.extend(f.values[:2])
    return clauses


def build_tuples_sql(
    dataset_id: str,
    query: TuplesQueryBody,
    date_range: DateRange,
    schema_fields: set[str],
) -> tuple[str, list[Any]]:
    """
    Generate SQL for a tuples query: distinct dimension values for one axis.

    Returns (sql, params) for parameterized execution.
    """
    params: list[Any] = []
    table = _quote(dataset_id)

    fields = query.fields or []
    if not fields:
        return f"SELECT 1 FROM {table} WHERE FALSE", params

    select_cols = []
    for f in fields:
        if f.field not in schema_fields:
            continue
        select_cols.append(_quote(f.field))
    if not select_cols:
        return f"SELECT 1 FROM {table} WHERE FALSE", params

    select_clause = ", ".join(select_cols)
    where_parts = []

    date_clause = _build_date_clause(date_range, params)
    if date_clause:
        where_parts.append(date_clause)

    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))

    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    group_clause = " GROUP BY " + ", ".join(select_cols)

    order_parts = []
    for f in fields:
        if f.field in schema_fields:
            col = _quote(f.field)
            direction = "DESC" if f.sort and f.sort.upper() == "DESC" else "ASC"
            order_parts.append(f"{col} {direction}")
    order_clause = (" ORDER BY " + ", ".join(order_parts)) if order_parts else ""

    paging = query.paging
    limit = paging.limit if paging else 200
    offset = paging.offset if paging else 0
    limit_clause = f" LIMIT {limit} OFFSET {offset}"

    sql = f"SELECT {select_clause} FROM {table}{where_clause}{group_clause}{order_clause}{limit_clause}"
    return sql, params


def build_tuples_count_sql(
    dataset_id: str,
    query: TuplesQueryBody,
    date_range: DateRange,
    schema_fields: set[str],
) -> tuple[str, list[Any]]:
    """Generate a COUNT query for total_count in tuples response."""
    params: list[Any] = []
    table = _quote(dataset_id)

    fields = query.fields or []
    select_cols = [_quote(f.field) for f in fields if f.field in schema_fields]
    if not select_cols:
        return "SELECT 0", params

    group_expr = ", ".join(select_cols)
    where_parts = []

    date_clause = _build_date_clause(date_range, params)
    if date_clause:
        where_parts.append(date_clause)
    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))

    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    sql = f"SELECT COUNT(*) FROM (SELECT {group_expr} FROM {table}{where_clause} GROUP BY {group_expr})"
    return sql, params


def build_cells_sql(
    dataset_id: str,
    query: CellsQueryBody,
    date_range: DateRange,
    schema_fields: set[str],
) -> tuple[str, list[Any]]:
    """
    Generate SQL for a cells query: aggregated measure values grouped by dimensions.

    Returns (sql, params) for parameterized execution.
    """
    params: list[Any] = []
    table = _quote(dataset_id)
    axes = query.axes or {}

    row_fields = [f["field"] for f in axes.get("rows", []) if isinstance(f, dict) and f.get("field") in schema_fields]
    col_fields = [f["field"] for f in axes.get("columns", []) if isinstance(f, dict) and f.get("field") in schema_fields]
    measures = axes.get("measures", [])

    dim_cols = [_quote(f) for f in row_fields + col_fields]
    agg_exprs = []
    for m in measures:
        if not isinstance(m, dict):
            continue
        field = m.get("field", "")
        agg = m.get("aggregation", "SUM").upper()
        alias = m.get("alias", f"{agg.lower()}_{field}")
        if field not in schema_fields:
            continue
        if agg in ("SUM", "COUNT", "AVG", "MIN", "MAX"):
            agg_exprs.append(f"{agg}({_quote(field)}) AS {_quote(alias)}")

    if not dim_cols and not agg_exprs:
        return f"SELECT 1 FROM {table} WHERE FALSE", params

    select_parts = dim_cols + agg_exprs
    select_clause = ", ".join(select_parts)

    where_parts = []
    date_clause = _build_date_clause(date_range, params)
    if date_clause:
        where_parts.append(date_clause)
    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))
    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    group_clause = (" GROUP BY " + ", ".join(dim_cols)) if dim_cols else ""

    sql = f"SELECT {select_clause} FROM {table}{where_clause}{group_clause}"
    return sql, params


def build_picklist_sql(
    dataset_id: str,
    query: PicklistQueryBody,
    date_range: DateRange,
    schema_fields: set[str],
) -> tuple[str, list[Any]]:
    """
    Generate SQL for a picklist query: distinct values for a single field.

    Returns (sql, params) for parameterized execution.
    """
    params: list[Any] = []
    table = _quote(dataset_id)

    field = query.field
    if not field or field not in schema_fields:
        return f"SELECT 1 FROM {table} WHERE FALSE", params

    col = _quote(field)
    where_parts = []

    date_clause = _build_date_clause(date_range, params)
    if date_clause:
        where_parts.append(date_clause)

    if query.search:
        search_val = query.search.replace("*", "%")
        where_parts.append(f"{col} LIKE ?")
        params.append(search_val)

    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))
    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    paging = query.paging
    limit = paging.limit if paging else 100
    offset = paging.offset if paging else 0

    sql = f"SELECT DISTINCT {col} AS value FROM {table}{where_clause} ORDER BY {col} LIMIT {limit} OFFSET {offset}"
    return sql, params


def build_picklist_count_sql(
    dataset_id: str,
    query: PicklistQueryBody,
    date_range: DateRange,
    schema_fields: set[str],
) -> tuple[str, list[Any]]:
    """Generate a COUNT query for total_count in picklist response."""
    params: list[Any] = []
    table = _quote(dataset_id)

    field = query.field
    if not field or field not in schema_fields:
        return "SELECT 0", params

    col = _quote(field)
    where_parts = []

    date_clause = _build_date_clause(date_range, params)
    if date_clause:
        where_parts.append(date_clause)

    if query.search:
        search_val = query.search.replace("*", "%")
        where_parts.append(f"{col} LIKE ?")
        params.append(search_val)

    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))
    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    sql = f"SELECT COUNT(DISTINCT {col}) FROM {table}{where_clause}"
    return sql, params
