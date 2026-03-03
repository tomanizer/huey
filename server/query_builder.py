"""
SQL query generation from typed request models.

Generates parameterized DuckDB SQL for tuples, cells, and picklist queries.
All identifiers are double-quoted to prevent injection; values use parameterized
placeholders.
"""

from typing import Any

from server.errors import ValidationAppError
from server.models import (
    CellsQueryBody,
    DateRange,
    DateRangeRange,
    DateRangeSingle,
    ExportQueryBody,
    PicklistQueryBody,
    TupleFilter,
    TuplesQueryBody,
)
from server.relation_builder import build_base_relation
from server.utils import quote_identifier as _quote


def _unknown_field_error(loc: list[Any], field: str) -> dict[str, Any]:
    return {
        "loc": loc,
        "msg": f"Unknown field: {field}",
        "type": "value_error.unknown_field",
    }


def _raise_if_unknown(errors: list[dict[str, Any]]) -> None:
    if errors:
        raise ValidationAppError(errors)


def validate_tuples_query_fields(query: TuplesQueryBody, schema_fields: set[str]) -> None:
    errors: list[dict[str, Any]] = []
    for idx, f in enumerate(query.fields or []):
        if f.field not in schema_fields:
            errors.append(_unknown_field_error(["body", "query", "fields", idx, "field"], f.field))
    for idx, f in enumerate(query.filters or []):
        if f.field not in schema_fields:
            errors.append(_unknown_field_error(["body", "query", "filters", idx, "field"], f.field))
    _raise_if_unknown(errors)


def _validate_axes_fields(axes: dict[str, Any] | None, errors: list[dict[str, Any]], schema_fields: set[str]) -> None:
    axis_names = ("rows", "columns", "measures")
    axes_data = axes or {}
    for axis_name in axis_names:
        for idx, item in enumerate(axes_data.get(axis_name, [])):
            if isinstance(item, dict) and isinstance(item.get("field"), str):
                field_name = item["field"]
                if field_name not in schema_fields:
                    errors.append(_unknown_field_error(["body", "query", "axes", axis_name, idx, "field"], field_name))


def _validate_filter_fields(filters: list[TupleFilter] | None, errors: list[dict[str, Any]], schema_fields: set[str]) -> None:
    for idx, f in enumerate(filters or []):
        if f.field not in schema_fields:
            errors.append(_unknown_field_error(["body", "query", "filters", idx, "field"], f.field))


def validate_cells_query_fields(query: CellsQueryBody, schema_fields: set[str]) -> None:
    errors: list[dict[str, Any]] = []
    _validate_axes_fields(query.axes, errors, schema_fields)
    _validate_filter_fields(query.filters, errors, schema_fields)
    _raise_if_unknown(errors)


def validate_picklist_query_fields(query: PicklistQueryBody, schema_fields: set[str]) -> None:
    errors: list[dict[str, Any]] = []
    if query.field and query.field not in schema_fields:
        errors.append(_unknown_field_error(["body", "query", "field"], query.field))
    _validate_filter_fields(query.filters, errors, schema_fields)
    _raise_if_unknown(errors)


def validate_export_query_fields(query: ExportQueryBody, schema_fields: set[str]) -> None:
    errors: list[dict[str, Any]] = []
    _validate_axes_fields(query.axes, errors, schema_fields)
    _validate_filter_fields(query.filters, errors, schema_fields)
    _raise_if_unknown(errors)


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
        col = _quote(f.field)
        if f.operator == "INCLUDE" and f.values:
            placeholders = ", ".join("?" for _ in f.values)
            clauses.append(f"{col} IN ({placeholders})")
            params.extend(f.values)
        elif f.operator == "EXCLUDE" and f.values:
            placeholders = ", ".join("?" for _ in f.values)
            clauses.append(f"{col} NOT IN ({placeholders})")
            params.extend(f.values)
        elif f.operator == "LIKE" and f.values:
            clauses.append(f"{col} LIKE ?")
            params.append(f.values[0])
        elif f.operator == "BETWEEN" and len(f.values) >= 2:
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
    validate_tuples_query_fields(query, schema_fields)
    fields = query.fields or []
    if not fields:
        return f"SELECT 1 FROM {_quote(dataset_id)} WHERE FALSE", []

    select_cols = []
    for f in fields:
        select_cols.append(_quote(f.field))
    if not select_cols:
        return f"SELECT 1 FROM {_quote(dataset_id)} WHERE FALSE", []

    required_columns = {f.field for f in fields}
    if query.filters:
        required_columns.update(f.field for f in query.filters)
    required_columns.add("date")

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql

    select_clause = ", ".join(select_cols)
    where_parts = []

    if not base.handles_date:
        date_clause = _build_date_clause(date_range, params)
        if date_clause:
            where_parts.append(date_clause)

    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))

    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    group_clause = " GROUP BY " + ", ".join(select_cols)

    order_parts = []
    for f in fields:
        col = _quote(f.field)
        order_parts.append(f"{col} {f.sort or 'ASC'}")
    order_clause = (" ORDER BY " + ", ".join(order_parts)) if order_parts else ""

    paging = query.paging
    limit = paging.limit if paging else 200
    offset = paging.offset if paging else 0
    limit_clause = f" LIMIT {limit} OFFSET {offset}"

    base_sql = f"SELECT {select_clause} FROM {table}{where_clause}{group_clause}"
    sql_body = (
        f"SELECT {select_clause}, COUNT(*) OVER() AS __count__ "
        f"FROM ({base_sql}) AS grouped{order_clause}{limit_clause}"
    )
    sql = f"{base.cte_sql + ' ' if base.cte_sql else ''}{sql_body}"
    return sql, params


def build_tuples_count_sql(
    dataset_id: str,
    query: TuplesQueryBody,
    date_range: DateRange,
    schema_fields: set[str],
) -> tuple[str, list[Any]]:
    """Generate a COUNT query for total_count in tuples response."""
    validate_tuples_query_fields(query, schema_fields)
    fields = query.fields or []
    select_cols = [_quote(f.field) for f in fields]
    if not select_cols:
        return "SELECT 0", []

    required_columns = {f.field for f in fields}
    if query.filters:
        required_columns.update(f.field for f in query.filters)
    required_columns.add("date")

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql
    group_expr = ", ".join(select_cols)
    where_parts = []

    if not base.handles_date:
        date_clause = _build_date_clause(date_range, params)
        if date_clause:
            where_parts.append(date_clause)
    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))

    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    sql_body = f"SELECT COUNT(*) FROM (SELECT {group_expr} FROM {table}{where_clause} GROUP BY {group_expr})"
    sql = f"{base.cte_sql + ' ' if base.cte_sql else ''}{sql_body}"
    return sql, params


def build_cells_sql(
    dataset_id: str,
    query: CellsQueryBody,
    date_range: DateRange,
    schema_fields: set[str],
    max_cells: int | None = None,
) -> tuple[str, list[Any]]:
    """
    Generate SQL for a cells query: aggregated measure values grouped by dimensions.

    Returns (sql, params) for parameterized execution.
    """
    validate_cells_query_fields(query, schema_fields)
    axes = query.axes or {}

    row_fields = [f["field"] for f in axes.get("rows", []) if isinstance(f, dict) and isinstance(f.get("field"), str)]
    col_fields = [f["field"] for f in axes.get("columns", []) if isinstance(f, dict) and isinstance(f.get("field"), str)]
    measures = axes.get("measures", [])

    dim_cols = [_quote(f) for f in row_fields + col_fields]
    agg_exprs = []
    for m in measures:
        if not isinstance(m, dict):
            continue
        field = m.get("field", "")
        agg = m.get("aggregation", "SUM").upper()
        alias = m.get("alias", f"{agg.lower()}_{field}")
        if not field:
            continue
        if agg in ("SUM", "COUNT", "AVG", "MIN", "MAX"):
            agg_exprs.append(f"{agg}({_quote(field)}) AS {_quote(alias)}")

    if not dim_cols and not agg_exprs:
        return f"SELECT 1 FROM {_quote(dataset_id)} WHERE FALSE", []

    required_columns = set(row_fields + col_fields)
    required_columns.update(m.get("field", "") for m in measures if isinstance(m, dict) and m.get("field"))
    if query.filters:
        required_columns.update(f.field for f in query.filters)
    required_columns.add("date")

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql

    select_parts = dim_cols + agg_exprs
    select_clause = ", ".join(select_parts)

    where_parts: list[str] = []
    if not base.handles_date:
        date_clause = _build_date_clause(date_range, params)
        if date_clause:
            where_parts.append(date_clause)
    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))
    filters_where = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    group_clause = (" GROUP BY " + ", ".join(dim_cols)) if dim_cols else ""

    # Build CTE chain starting from the base relation. When base.cte_sql is
    # present (e.g., parquet_partitioned mode), reuse it so that any
    # parameterised source (read_parquet with patterns/date params) is
    # preserved and matches the params list.
    ctes: list[str] = []
    root_table = "base"
    if base.cte_sql:
        base_def = base.cte_sql.strip()
        if base_def.upper().startswith("WITH "):
            base_def = base_def[5:].strip()
        ctes.append(base_def)
        if filters_where:
            # Apply additional filters on top of the base CTE.
            ctes.append(f"filtered_base AS (SELECT * FROM base{filters_where})")
            root_table = "filtered_base"
    else:
        # No existing CTE; construct base from the underlying table directly.
        ctes.append(f"base AS (SELECT * FROM {table}{filters_where})")

    row_window = query.rows
    row_cte_name = None
    if row_fields:
        row_cte_name = "row_window"
        row_select_cols = ", ".join(_quote(f) for f in row_fields)
        row_order = " ORDER BY " + ", ".join(_quote(f) for f in row_fields)
        row_limit = ""
        if row_window:
            limit_val = row_window.count
            offset_val = row_window.start_index or 0
            if limit_val is not None:
                row_limit = f" LIMIT {limit_val} OFFSET {offset_val}"
            elif offset_val:
                row_limit = f" OFFSET {offset_val}"
        ctes.append(
            f"{row_cte_name} AS (SELECT DISTINCT {row_select_cols} FROM {root_table}{row_order}{row_limit})"
        )

    col_window = query.columns
    col_cte_name = None
    if col_fields:
        col_cte_name = "col_window"
        col_select_cols = ", ".join(_quote(f) for f in col_fields)
        col_order = " ORDER BY " + ", ".join(_quote(f) for f in col_fields)
        col_limit = ""
        if col_window:
            limit_val = col_window.count
            offset_val = col_window.start_index or 0
            if limit_val is not None:
                col_limit = f" LIMIT {limit_val} OFFSET {offset_val}"
            elif offset_val:
                col_limit = f" OFFSET {offset_val}"
        ctes.append(
            f"{col_cte_name} AS (SELECT DISTINCT {col_select_cols} FROM {root_table}{col_order}{col_limit})"
        )

    with_clause = f"WITH {', '.join(ctes)}"

    joins = []
    if row_cte_name:
        joins.append(f"INNER JOIN {row_cte_name} USING ({', '.join(_quote(f) for f in row_fields)})")
    if col_cte_name:
        joins.append(f"INNER JOIN {col_cte_name} USING ({', '.join(_quote(f) for f in col_fields)})")

    from_clause = f" FROM {root_table} " + " ".join(joins)

    order_clause = (" ORDER BY " + ", ".join(dim_cols)) if dim_cols else ""
    limit_clause = f" LIMIT {max_cells}" if max_cells else ""

    sql = f"{with_clause} SELECT {select_clause}{from_clause}{group_clause}{order_clause}{limit_clause}"
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
    validate_picklist_query_fields(query, schema_fields)
    field = query.field
    if not field:
        return f"SELECT 1 FROM {_quote(dataset_id)} WHERE FALSE", []

    col = _quote(field)
    required_columns = {field, "date"}
    if query.filters:
        required_columns.update(f.field for f in query.filters)

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql
    where_parts = []

    if not base.handles_date:
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

    base_sql = f"SELECT DISTINCT {col} AS value FROM {table}{where_clause}"
    sql_body = (
        f"SELECT value, COUNT(*) OVER() AS __count__ "
        f"FROM ({base_sql}) AS distinct_values ORDER BY value LIMIT {limit} OFFSET {offset}"
    )
    sql = f"{base.cte_sql + ' ' if base.cte_sql else ''}{sql_body}"
    return sql, params


def build_picklist_count_sql(
    dataset_id: str,
    query: PicklistQueryBody,
    date_range: DateRange,
    schema_fields: set[str],
) -> tuple[str, list[Any]]:
    """Generate a COUNT query for total_count in picklist response."""
    validate_picklist_query_fields(query, schema_fields)
    field = query.field
    if not field:
        return "SELECT 0", []

    col = _quote(field)
    required_columns = {field, "date"}
    if query.filters:
        required_columns.update(f.field for f in query.filters)

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql
    where_parts = []

    if not base.handles_date:
        date_clause = _build_date_clause(date_range, params)
        if date_clause:
            where_parts.append(date_clause)

    if query.search:
        search_val = query.search.replace("*", "%")
        where_parts.append(f"{col} LIKE ?")
        params.append(search_val)

    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))
    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    sql_body = f"SELECT COUNT(DISTINCT {col}) FROM {table}{where_clause}"
    sql = f"{base.cte_sql + ' ' if base.cte_sql else ''}{sql_body}"
    return sql, params


def build_export_sql(
    dataset_id: str,
    query: ExportQueryBody,
    date_range: DateRange,
    schema_fields: set[str],
) -> tuple[str, list[Any], list[str]]:
    """
    Generate SQL for an export query: flat rows of dimensions + aggregated measures.

    Returns (sql, params, headers) where headers is the list of column names
    for the CSV header row.
    """
    validate_export_query_fields(query, schema_fields)
    axes = query.axes or {}
    max_rows = query.max_rows

    row_fields = [
        f["field"]
        for f in axes.get("rows", [])
        if isinstance(f, dict) and isinstance(f.get("field"), str)
    ]
    col_fields = [
        f["field"]
        for f in axes.get("columns", [])
        if isinstance(f, dict) and isinstance(f.get("field"), str)
    ]
    measures = axes.get("measures", [])

    dim_cols = [_quote(f) for f in row_fields + col_fields]
    dim_headers = row_fields + col_fields
    agg_exprs = []
    agg_headers: list[str] = []
    for m in measures:
        if not isinstance(m, dict):
            continue
        field = m.get("field", "")
        agg = m.get("aggregation", "SUM").upper()
        alias = m.get("alias", f"{agg.lower()}_{field}")
        if not field:
            continue
        if agg in ("SUM", "COUNT", "AVG", "MIN", "MAX"):
            agg_exprs.append(f"{agg}({_quote(field)}) AS {_quote(alias)}")
            agg_headers.append(alias)

    required_columns = set(row_fields + col_fields)
    required_columns.update(m.get("field", "") for m in measures if isinstance(m, dict) and m.get("field"))
    if query.filters:
        required_columns.update(f.field for f in query.filters)
    required_columns.add("date")

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql

    if not dim_cols and not agg_exprs:
        all_fields = sorted(schema_fields)
        select_clause = ", ".join(_quote(f) for f in all_fields)
        headers = all_fields
    else:
        select_parts = dim_cols + agg_exprs
        select_clause = ", ".join(select_parts)
        headers = dim_headers + agg_headers

    where_parts = []
    if not base.handles_date:
        date_clause = _build_date_clause(date_range, params)
        if date_clause:
            where_parts.append(date_clause)
    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))
    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    group_clause = ""
    if dim_cols and agg_exprs:
        group_clause = " GROUP BY " + ", ".join(dim_cols)

    order_clause = ""
    if dim_cols:
        order_clause = " ORDER BY " + ", ".join(dim_cols)

    limit_clause = f" LIMIT {max_rows}"

    sql_body = f"SELECT {select_clause} FROM {table}{where_clause}{group_clause}{order_clause}{limit_clause}"
    sql = f"{base.cte_sql + ' ' if base.cte_sql else ''}{sql_body}"
    return sql, params, headers
