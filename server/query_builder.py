"""
SQL query generation from typed request models.

Generates parameterized DuckDB SQL for tuples, cells, and picklist queries.
All identifiers are double-quoted to prevent injection; values use parameterized
placeholders.
"""

from typing import Any

from server import datasets
from server.derivations import apply_derivation, get_output_name, quote_output_name
from server.errors import AggregationNotSupportedError, ValidationAppError
from server.models import (
    AxesSpec,
    CellsQueryBody,
    DateRange,
    DateRangeRange,
    DateRangeSingle,
    ExportQueryBody,
    PicklistQueryBody,
    TupleFilter,
    TuplesQueryBody,
)
from server.relation_builder import build_base_relation, required_relation_columns
from server.utils import quote_identifier as _quote

_NUMERIC_TYPES = {
    "TINYINT",
    "SMALLINT",
    "INTEGER",
    "BIGINT",
    "HUGEINT",
    "UTINYINT",
    "USMALLINT",
    "UINTEGER",
    "UBIGINT",
    "UHUGEINT",
    "REAL",
    "DOUBLE",
    "FLOAT",
    "INT64",
    "INT32",
    "INT16",
    "INT8",
    "UINT64",
    "UINT32",
    "UINT16",
    "UINT8",
    "FLOAT32",
    "FLOAT64",
}

_BOOLEAN_TYPES = {"BOOLEAN", "BOOL"}
_NUMERIC_ONLY_AGGREGATIONS = {
    "sum",
    "avg",
    "stdev",
    "variance",
    "geomean",
    "kurtosis",
    "skewness",
    "mad",
}
_BOOLEAN_ONLY_AGGREGATIONS = {"and", "or", "count_if_true", "count_if_false"}


def _get_schema_field_types(dataset_id: str) -> dict[str, str]:
    schema = datasets.get_schema(dataset_id) or {}
    fields = schema.get("fields", []) if isinstance(schema, dict) else []
    field_types: dict[str, str] = {}
    for field in fields:
        if isinstance(field, dict) and field.get("name") and field.get("type"):
            field_types[str(field["name"])] = str(field["type"])
    return field_types


def _normalize_type_name(type_name: str | None) -> str:
    if not type_name:
        return ""
    return str(type_name).upper().strip()


def _is_numeric_type(type_name: str | None) -> bool:
    normalized = _normalize_type_name(type_name)
    if normalized in _NUMERIC_TYPES:
        return True
    if normalized.startswith(("DECIMAL", "NUMERIC", "FLOAT")):
        return True
    return False


def _is_boolean_type(type_name: str | None) -> bool:
    return _normalize_type_name(type_name) in _BOOLEAN_TYPES


def _validate_measure_specs(
    dataset_id: str,
    measures: list[Any],
    schema_fields: set[str],
    loc_prefix: list[Any],
) -> None:
    schema_field_types = _get_schema_field_types(dataset_id)
    errors: list[dict[str, Any]] = []
    aggregation_errors: list[dict[str, Any]] = []

    for index, measure in enumerate(measures):
        field_type = schema_field_types.get(measure.field)
        aggregation = measure.aggregation

        if aggregation in _NUMERIC_ONLY_AGGREGATIONS and not _is_numeric_type(field_type):
            aggregation_errors.append(
                {
                    "loc": [*loc_prefix, index, "aggregation"],
                    "msg": f"Aggregation {aggregation} is not supported for field type {field_type or 'unknown'}",
                    "type": "aggregation_not_supported",
                    "ctx": {"aggregation": aggregation, "field": measure.field, "field_type": field_type},
                }
            )
        elif aggregation in _BOOLEAN_ONLY_AGGREGATIONS and not _is_boolean_type(field_type):
            aggregation_errors.append(
                {
                    "loc": [*loc_prefix, index, "aggregation"],
                    "msg": f"Aggregation {aggregation} is only supported for boolean fields",
                    "type": "aggregation_not_supported",
                    "ctx": {"aggregation": aggregation, "field": measure.field, "field_type": field_type},
                }
            )

        if aggregation in ("first", "last") and measure.sort_by not in schema_fields:
            errors.append(
                {
                    "loc": [*loc_prefix, index, "sort_by"],
                    "msg": f"Unknown field: {measure.sort_by}",
                    "type": "value_error.unknown_field",
                }
            )

    if aggregation_errors:
        raise AggregationNotSupportedError(aggregation_errors)
    _raise_if_unknown(errors)


def _build_aggregation_expression(measure: Any) -> str:
    field = measure.field
    aggregation = measure.aggregation
    alias = measure.alias or f"{aggregation}_{field}"
    quoted_field = _quote(field)
    quoted_alias = _quote(alias)

    if aggregation == "sum":
        return f"SUM({quoted_field}) AS {quoted_alias}"
    if aggregation == "avg":
        return f"AVG({quoted_field}) AS {quoted_alias}"
    if aggregation == "min":
        return f"MIN({quoted_field}) AS {quoted_alias}"
    if aggregation == "max":
        return f"MAX({quoted_field}) AS {quoted_alias}"
    if aggregation == "count":
        return f"COUNT({quoted_field}) AS {quoted_alias}"
    if aggregation == "distinct_count":
        return f"COUNT(DISTINCT {quoted_field}) AS {quoted_alias}"
    if aggregation == "median":
        return f"MEDIAN({quoted_field}) AS {quoted_alias}"
    if aggregation == "mode":
        return f"MODE({quoted_field}) AS {quoted_alias}"
    if aggregation == "stdev":
        return f"STDDEV_SAMP({quoted_field}) AS {quoted_alias}"
    if aggregation == "variance":
        return f"VAR_SAMP({quoted_field}) AS {quoted_alias}"
    if aggregation == "geomean":
        return f"GEOMEAN({quoted_field}) AS {quoted_alias}"
    if aggregation == "entropy":
        return f"ENTROPY({quoted_field}) AS {quoted_alias}"
    if aggregation == "kurtosis":
        return f"KURTOSIS({quoted_field}) AS {quoted_alias}"
    if aggregation == "skewness":
        return f"SKEWNESS({quoted_field}) AS {quoted_alias}"
    if aggregation == "mad":
        return f"MAD({quoted_field}) AS {quoted_alias}"
    if aggregation == "and":
        return f"BOOL_AND({quoted_field}) AS {quoted_alias}"
    if aggregation == "or":
        return f"BOOL_OR({quoted_field}) AS {quoted_alias}"
    if aggregation == "count_if_true":
        return f"COUNT({quoted_field}) FILTER (WHERE {quoted_field}) AS {quoted_alias}"
    if aggregation == "count_if_false":
        return f"COUNT({quoted_field}) FILTER (WHERE NOT {quoted_field}) AS {quoted_alias}"
    if aggregation == "list":
        return f"LIST({quoted_field}) AS {quoted_alias}"
    if aggregation == "unique_list":
        return f"LIST(DISTINCT {quoted_field} ORDER BY {quoted_field}) AS {quoted_alias}"
    if aggregation == "first":
        return f"FIRST({quoted_field} ORDER BY {_quote(measure.sort_by)}) AS {quoted_alias}"
    if aggregation == "last":
        return f"LAST({quoted_field} ORDER BY {_quote(measure.sort_by)}) AS {quoted_alias}"
    raise ValidationAppError(
        [
            {
                "loc": ["body", "axes", "measures", "aggregation"],
                "msg": f"Unsupported aggregation: {aggregation}",
                "type": "aggregation_not_supported",
                "ctx": {"aggregation": aggregation, "field": field},
            }
        ]
    )


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
            errors.append(_unknown_field_error(["body", "fields", idx, "field"], f.field))
    for idx, f in enumerate(query.filters or []):
        if f.field not in schema_fields:
            errors.append(_unknown_field_error(["body", "filters", idx, "field"], f.field))
    _raise_if_unknown(errors)


def _validate_axes_fields(
    axes: AxesSpec | None,
    errors: list[dict[str, Any]],
    schema_fields: set[str],
) -> None:
    if axes is None:
        return
    for axis_name, items in (("rows", axes.rows), ("columns", axes.columns), ("measures", axes.measures)):
        for idx, item in enumerate(items):
            if item.field not in schema_fields:
                errors.append(
                    _unknown_field_error(
                        ["body", "axes", axis_name, idx, "field"],
                        item.field,
                    )
                )


def _validate_filter_fields(
    filters: list[TupleFilter] | None,
    errors: list[dict[str, Any]],
    schema_fields: set[str],
) -> None:
    for idx, f in enumerate(filters or []):
        if f.field not in schema_fields:
            errors.append(_unknown_field_error(["body", "filters", idx, "field"], f.field))


def validate_cells_query_fields(query: CellsQueryBody, schema_fields: set[str]) -> None:
    errors: list[dict[str, Any]] = []
    _validate_axes_fields(query.axes, errors, schema_fields)
    _validate_filter_fields(query.filters, errors, schema_fields)
    _raise_if_unknown(errors)


def validate_picklist_query_fields(query: PicklistQueryBody, schema_fields: set[str]) -> None:
    errors: list[dict[str, Any]] = []
    if query.field and query.field not in schema_fields:
        errors.append(_unknown_field_error(["body", "field"], query.field))
    _validate_filter_fields(query.filters, errors, schema_fields)
    _raise_if_unknown(errors)


def _build_dimension_selects(
    dataset_id: str,
    items: list[Any],
    schema_fields: set[str],
    loc_prefix: list[Any],
) -> list[dict[str, str]]:
    schema_field_types = _get_schema_field_types(dataset_id)
    selects = []
    for index, item in enumerate(items):
        output_name = get_output_name(item.field, getattr(item, "derivation", None), getattr(item, "alias", None))
        if getattr(item, "derivation", None):
            expression = apply_derivation(
                item.derivation,
                _quote(item.field),
                item.field,
                schema_field_types.get(item.field),
                [*loc_prefix, index, "derivation"],
            )
        else:
            expression = _quote(item.field)
        selects.append(
            {
                "field": item.field,
                "expression": expression,
                "output_name": output_name,
                "select_sql": f"{expression} AS {quote_output_name(item.field, getattr(item, 'derivation', None), getattr(item, 'alias', None))}",
                "column_sql": quote_output_name(item.field, getattr(item, "derivation", None), getattr(item, "alias", None)),
                "sort": getattr(item, "sort", None),
            }
        )
    return selects


def validate_export_query_fields(
    dataset_id: str,
    query: ExportQueryBody,
    schema_fields: set[str],
) -> None:
    errors: list[dict[str, Any]] = []
    _validate_axes_fields(query.axes, errors, schema_fields)
    _validate_filter_fields(query.filters, errors, schema_fields)
    _raise_if_unknown(errors)
    _validate_measure_specs(
        dataset_id,
        list(query.axes.measures if query.axes else []),
        schema_fields,
        ["body", "query", "axes", "measures"],
    )


def _build_date_clause(date_range: DateRange | None, params: list[Any]) -> str:
    """Build a WHERE clause fragment for the date range."""
    if date_range is None:
        return ""
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
        if f.operator == "include" and f.values:
            placeholders = ", ".join("?" for _ in f.values)
            clauses.append(f"{col} IN ({placeholders})")
            params.extend(f.values)
        elif f.operator == "exclude" and f.values:
            placeholders = ", ".join("?" for _ in f.values)
            clauses.append(f"{col} NOT IN ({placeholders})")
            params.extend(f.values)
        elif f.operator == "like" and f.values:
            clauses.append(f"{col} LIKE ?")
            params.append(f.values[0])
        elif f.operator == "between" and len(f.values) >= 2:
            clauses.append(f"{col} BETWEEN ? AND ?")
            params.extend(f.values[:2])
        elif f.operator == "gt" and f.values:
            clauses.append(f"{col} > ?")
            params.append(f.values[0])
        elif f.operator == "gte" and f.values:
            clauses.append(f"{col} >= ?")
            params.append(f.values[0])
        elif f.operator == "lt" and f.values:
            clauses.append(f"{col} < ?")
            params.append(f.values[0])
        elif f.operator == "lte" and f.values:
            clauses.append(f"{col} <= ?")
            params.append(f.values[0])
        elif f.operator == "is_null":
            clauses.append(f"{col} IS NULL")
        elif f.operator == "not_null":
            clauses.append(f"{col} IS NOT NULL")
    return clauses


def build_tuples_sql(
    dataset_id: str,
    query: TuplesQueryBody,
    date_range: DateRange | None,
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

    dimension_selects = _build_dimension_selects(dataset_id, list(fields), schema_fields, ["body", "fields"])
    select_cols = [select["column_sql"] for select in dimension_selects]
    if not select_cols:
        return f"SELECT 1 FROM {_quote(dataset_id)} WHERE FALSE", []

    required_columns = {f.field for f in fields}
    if query.filters:
        required_columns.update(f.field for f in query.filters)
    required_columns.update(required_relation_columns(dataset_id))

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql

    projection_clause = ", ".join(select["select_sql"] for select in dimension_selects)
    where_parts = []

    if not base.handles_date and base.requires_time_filter:
        date_clause = _build_date_clause(date_range, params)
        if date_clause:
            where_parts.append(date_clause)

    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))

    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    projected_from = f"(SELECT {projection_clause} FROM {table}{where_clause}) AS projected"
    group_clause = " GROUP BY " + ", ".join(select_cols)

    order_parts = []
    for select in dimension_selects:
        order_parts.append(f"{select['column_sql']} {select['sort'] or 'ASC'}")
    order_clause = (" ORDER BY " + ", ".join(order_parts)) if order_parts else ""

    paging = query.paging
    limit = paging.limit if paging else 200
    offset = paging.offset if paging else 0
    limit_clause = f" LIMIT {limit} OFFSET {offset}"

    select_clause = ", ".join(select_cols)
    base_sql = f"SELECT {select_clause} FROM {projected_from}{group_clause}"
    sql_body = (
        f"SELECT {select_clause}, COUNT(*) OVER() AS __count__ "
        f"FROM ({base_sql}) AS grouped{order_clause}{limit_clause}"
    )
    sql = f"{base.cte_sql + ' ' if base.cte_sql else ''}{sql_body}"
    return sql, params


def build_tuples_count_sql(
    dataset_id: str,
    query: TuplesQueryBody,
    date_range: DateRange | None,
    schema_fields: set[str],
) -> tuple[str, list[Any]]:
    """Generate a COUNT query for total_count in tuples response."""
    validate_tuples_query_fields(query, schema_fields)
    fields = query.fields or []
    dimension_selects = _build_dimension_selects(dataset_id, list(fields), schema_fields, ["body", "fields"])
    select_cols = [select["column_sql"] for select in dimension_selects]
    if not select_cols:
        return "SELECT 0", []

    required_columns = {f.field for f in fields}
    if query.filters:
        required_columns.update(f.field for f in query.filters)
    required_columns.update(required_relation_columns(dataset_id))

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql
    group_expr = ", ".join(select_cols)
    where_parts = []

    if not base.handles_date and base.requires_time_filter:
        date_clause = _build_date_clause(date_range, params)
        if date_clause:
            where_parts.append(date_clause)
    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))

    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    projection_clause = ", ".join(select["select_sql"] for select in dimension_selects)
    projected_from = f"(SELECT {projection_clause} FROM {table}{where_clause}) AS projected"
    sql_body = f"SELECT COUNT(*) FROM (SELECT {group_expr} FROM {projected_from} GROUP BY {group_expr})"
    sql = f"{base.cte_sql + ' ' if base.cte_sql else ''}{sql_body}"
    return sql, params


def build_cells_sql(
    dataset_id: str,
    query: CellsQueryBody,
    date_range: DateRange | None,
    schema_fields: set[str],
    max_cells: int | None = None,
) -> tuple[str, list[Any]]:
    """
    Generate SQL for a cells query: aggregated measure values grouped by dimensions.

    Returns (sql, params) for parameterized execution.
    """
    validate_cells_query_fields(query, schema_fields)
    axes = query.axes

    row_specs = _build_dimension_selects(dataset_id, list(axes.rows if axes else []), schema_fields, ["body", "axes", "rows"])
    col_specs = _build_dimension_selects(dataset_id, list(axes.columns if axes else []), schema_fields, ["body", "axes", "columns"])
    row_fields = [spec["output_name"] for spec in row_specs]
    col_fields = [spec["output_name"] for spec in col_specs]
    measures = axes.measures if axes else []
    _validate_measure_specs(dataset_id, list(measures), schema_fields, ["body", "axes", "measures"])

    dim_cols = [spec["column_sql"] for spec in row_specs + col_specs]
    agg_exprs = []
    for m in measures:
        agg_exprs.append(_build_aggregation_expression(m))

    if not dim_cols and not agg_exprs:
        return f"SELECT 1 FROM {_quote(dataset_id)} WHERE FALSE", []

    if not dim_cols and not agg_exprs:
        required_columns = set(schema_fields)
    else:
        required_columns = {spec["field"] for spec in row_specs + col_specs}
        required_columns.update(m.field for m in measures)
        required_columns.update(m.sort_by for m in measures if getattr(m, "sort_by", None))
    if query.filters:
        required_columns.update(f.field for f in query.filters)
    required_columns.update(required_relation_columns(dataset_id))

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql

    select_parts = dim_cols + agg_exprs
    select_clause = ", ".join(select_parts)

    where_parts: list[str] = []
    if not base.handles_date and base.requires_time_filter:
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
    projection_columns = []
    included_source_columns = set()
    for source_field in required_columns:
        if source_field and source_field not in included_source_columns:
            projection_columns.append(_quote(source_field))
            included_source_columns.add(source_field)
    for spec in row_specs + col_specs:
        if spec["output_name"] != spec["field"] or spec["expression"] != _quote(spec["field"]):
            projection_columns.append(spec["select_sql"])

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

    ctes.append(f"projected_base AS (SELECT {', '.join(projection_columns)} FROM {root_table})")
    root_table = "projected_base"

    row_window = query.rows
    row_cte_name = None
    if row_fields:
        row_cte_name = "row_window"
        row_select_cols = ", ".join(spec["column_sql"] for spec in row_specs)
        row_order = " ORDER BY " + ", ".join(spec["column_sql"] for spec in row_specs)
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
        col_select_cols = ", ".join(spec["column_sql"] for spec in col_specs)
        col_order = " ORDER BY " + ", ".join(spec["column_sql"] for spec in col_specs)
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
        joins.append(f"INNER JOIN {row_cte_name} USING ({', '.join(spec['column_sql'] for spec in row_specs)})")
    if col_cte_name:
        joins.append(f"INNER JOIN {col_cte_name} USING ({', '.join(spec['column_sql'] for spec in col_specs)})")

    from_clause = f" FROM {root_table} " + " ".join(joins)

    order_clause = (" ORDER BY " + ", ".join(dim_cols)) if dim_cols else ""
    limit_clause = f" LIMIT {max_cells}" if max_cells else ""

    sql = f"{with_clause} SELECT {select_clause}{from_clause}{group_clause}{order_clause}{limit_clause}"
    return sql, params


def build_picklist_sql(
    dataset_id: str,
    query: PicklistQueryBody,
    date_range: DateRange | None,
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

    field_spec = type("PicklistFieldSpec", (), {"field": field, "derivation": query.derivation, "alias": query.alias})()
    select_spec = _build_dimension_selects(dataset_id, [field_spec], schema_fields, ["body"])[0]
    output_col = select_spec["column_sql"]
    required_columns = {field}
    required_columns.update(required_relation_columns(dataset_id))
    if query.filters:
        required_columns.update(f.field for f in query.filters)

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql
    base_where_parts = []

    if not base.handles_date and base.requires_time_filter:
        date_clause = _build_date_clause(date_range, params)
        if date_clause:
            base_where_parts.append(date_clause)

    base_where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))
    base_where_clause = (" WHERE " + " AND ".join(base_where_parts)) if base_where_parts else ""

    projection_columns = [_quote(source_field) for source_field in sorted(required_columns)]
    if select_spec["output_name"] != field or select_spec["expression"] != _quote(field):
        projection_columns.append(select_spec["select_sql"])

    projected_from = f"(SELECT {', '.join(projection_columns)} FROM {table}{base_where_clause}) AS projected"

    search_where_parts = []
    if query.search:
        search_val = query.search.replace("*", "%")
        search_where_parts.append(f"{output_col} LIKE ?")
        params.append(search_val)
    where_clause = (" WHERE " + " AND ".join(search_where_parts)) if search_where_parts else ""

    paging = query.paging
    limit = paging.limit if paging else 100
    offset = paging.offset if paging else 0

    base_sql = (
        f"SELECT {output_col} AS value, COUNT(*) AS value_count "
        f"FROM {projected_from}{where_clause} GROUP BY {output_col}"
    )
    sql_body = (
        f"SELECT value, value_count, COUNT(*) OVER() AS __count__ "
        f"FROM ({base_sql}) AS distinct_values ORDER BY value LIMIT {limit} OFFSET {offset}"
    )
    sql = f"{base.cte_sql + ' ' if base.cte_sql else ''}{sql_body}"
    return sql, params


def build_picklist_count_sql(
    dataset_id: str,
    query: PicklistQueryBody,
    date_range: DateRange | None,
    schema_fields: set[str],
) -> tuple[str, list[Any]]:
    """Generate a COUNT query for total_count in picklist response."""
    validate_picklist_query_fields(query, schema_fields)
    field = query.field
    if not field:
        return "SELECT 0", []

    field_spec = type("PicklistFieldSpec", (), {"field": field, "derivation": query.derivation, "alias": query.alias})()
    select_spec = _build_dimension_selects(dataset_id, [field_spec], schema_fields, ["body"])[0]
    output_col = select_spec["column_sql"]
    required_columns = {field}
    required_columns.update(required_relation_columns(dataset_id))
    if query.filters:
        required_columns.update(f.field for f in query.filters)

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql
    base_where_parts = []

    if not base.handles_date and base.requires_time_filter:
        date_clause = _build_date_clause(date_range, params)
        if date_clause:
            base_where_parts.append(date_clause)

    base_where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))
    base_where_clause = (" WHERE " + " AND ".join(base_where_parts)) if base_where_parts else ""

    projection_columns = [_quote(source_field) for source_field in sorted(required_columns)]
    if select_spec["output_name"] != field or select_spec["expression"] != _quote(field):
        projection_columns.append(select_spec["select_sql"])

    projected_from = f"(SELECT {', '.join(projection_columns)} FROM {table}{base_where_clause}) AS projected"

    search_where_parts = []

    if query.search:
        search_val = query.search.replace("*", "%")
        search_where_parts.append(f"{output_col} LIKE ?")
        params.append(search_val)
    where_clause = (" WHERE " + " AND ".join(search_where_parts)) if search_where_parts else ""

    sql_body = f"SELECT COUNT(DISTINCT {output_col}) FROM {projected_from}{where_clause}"
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
    validate_export_query_fields(dataset_id, query, schema_fields)
    axes = query.axes
    max_rows = query.max_rows

    row_specs = _build_dimension_selects(dataset_id, list(axes.rows if axes else []), schema_fields, ["body", "query", "axes", "rows"])
    col_specs = _build_dimension_selects(dataset_id, list(axes.columns if axes else []), schema_fields, ["body", "query", "axes", "columns"])
    measures = axes.measures if axes else []

    dim_cols = [spec["column_sql"] for spec in row_specs + col_specs]
    dim_headers = [spec["output_name"] for spec in row_specs + col_specs]
    agg_exprs = []
    agg_headers: list[str] = []
    for m in measures:
        alias = m.alias or f"{m.aggregation}_{m.field}"
        agg_exprs.append(_build_aggregation_expression(m))
        agg_headers.append(alias)

    if not dim_cols and not agg_exprs:
        required_columns = set(schema_fields)
    else:
        required_columns = {spec["field"] for spec in row_specs + col_specs}
        required_columns.update(m.field for m in measures)
        required_columns.update(m.sort_by for m in measures if getattr(m, "sort_by", None))
    if query.filters:
        required_columns.update(f.field for f in query.filters)
    required_columns.update(required_relation_columns(dataset_id))

    base = build_base_relation(dataset_id, date_range, required_columns)
    params: list[Any] = list(base.params)
    table = base.from_sql

    where_parts = []
    if not base.handles_date and base.requires_time_filter:
        date_clause = _build_date_clause(date_range, params)
        if date_clause:
            where_parts.append(date_clause)
    where_parts.extend(_build_filter_clauses(query.filters, params, schema_fields))
    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    projection_source_fields = sorted(schema_fields) if not dim_cols and not agg_exprs else sorted(required_columns)
    projection_columns = [_quote(source_field) for source_field in projection_source_fields]
    for spec in row_specs + col_specs:
        if spec["output_name"] != spec["field"] or spec["expression"] != _quote(spec["field"]):
            projection_columns.append(spec["select_sql"])

    projected_from = f"(SELECT {', '.join(projection_columns)} FROM {table}{where_clause}) AS projected"

    if not dim_cols and not agg_exprs:
        all_fields = sorted(schema_fields)
        select_clause = ", ".join(_quote(f) for f in all_fields)
        headers = all_fields
    else:
        select_parts = dim_cols + agg_exprs
        select_clause = ", ".join(select_parts)
        headers = dim_headers + agg_headers

    group_clause = ""
    if dim_cols and agg_exprs:
        group_clause = " GROUP BY " + ", ".join(dim_cols)

    order_clause = ""
    if dim_cols:
        order_clause = " ORDER BY " + ", ".join(dim_cols)

    limit_clause = f" LIMIT {max_rows}"

    sql_body = f"SELECT {select_clause} FROM {projected_from}{group_clause}{order_clause}{limit_clause}"
    sql = f"{base.cte_sql + ' ' if base.cte_sql else ''}{sql_body}"
    return sql, params, headers
