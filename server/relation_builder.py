"""
Base relation builder for query execution.

Provides a partition-aware parquet relation when configured, otherwise
falls back to the seeded sample tables.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable

from server import datasets
from server.config import get_settings
from server.errors import DatasetConfigError, PartitionConfigError, PartitionNotFoundError
from server.models import (
    DateRange,
    DateRangeRange,
    DateRangeSingle,
    DateRangeSpanLimitError,
    raise_date_range_validation_error,
    validate_date_range_span,
)
from server.s3 import build_partition_path
from server.utils import quote_identifier

_HIVE_TYPE_TOKEN = re.compile(r"^[A-Z0-9_ ()]+$")


@dataclass
class BaseRelation:
    """Represents the FROM source for query builders."""

    cte_sql: str | None
    from_sql: str
    params: list[Any]
    handles_date: bool
    requires_time_filter: bool = True


def _dates_for_range(date_range: DateRange | None) -> list[str]:
    if date_range is None:
        return []
    try:
        validate_date_range_span(date_range, get_settings().max_date_range_days)
    except DateRangeSpanLimitError as exc:
        raise_date_range_validation_error(exc)
    if isinstance(date_range, DateRangeSingle):
        return [date_range.date]
    if isinstance(date_range, DateRangeRange):
        start = date.fromisoformat(date_range.start)
        end = date.fromisoformat(date_range.end)
        days = []
        cursor = start
        while cursor <= end:
            days.append(cursor.isoformat())
            cursor += timedelta(days=1)
        return days
    return []


def _ensure_columns(required_columns: Iterable[str]) -> list[str]:
    cols = []
    for c in required_columns:
        if c not in cols:
            cols.append(c)
    return cols


def _time_filter_sql(
    column: str,
    filter_type: str,
    date_range: DateRange | None,
    params: list[Any],
) -> str:
    quoted_col = quote_identifier(column)
    expr = quoted_col
    if filter_type in {"timestamp", "string"}:
        expr = f"CAST({quoted_col} AS DATE)"
    if isinstance(date_range, DateRangeSingle):
        params.append(date_range.date)
        return f"{expr} = ?"
    if isinstance(date_range, DateRangeRange):
        params.extend([date_range.start, date_range.end])
        return f"{expr} BETWEEN ? AND ?"
    return ""


def _read_options_sql(dataset_id: str, source: datasets.DatasetSourceConfig) -> str:
    opts = source.read_options
    parts: list[str] = []
    if isinstance(opts.hive_partitioning, bool):
        parts.append(f"hive_partitioning = {'true' if opts.hive_partitioning else 'false'}")
    if opts.union_by_name:
        parts.append("union_by_name = true")
    if opts.filename:
        parts.append("filename = true")
    if opts.hive_types:
        entries: list[str] = []
        for key, type_name in opts.hive_types.items():
            normalized_type = type_name.strip().upper()
            if not _HIVE_TYPE_TOKEN.match(normalized_type):
                raise DatasetConfigError(
                    dataset_id,
                    "Invalid hive type token in source.read_options.hive_types",
                    {"column": key, "type": type_name},
                )
            entries.append(f"'{key}': {normalized_type}")
        parts.append(f"hive_types = {{{', '.join(entries)}}}")
    return f", {', '.join(parts)}" if parts else ""


def _expand_date_partition_uris(
    base_uri: str,
    date_range: DateRange,
    partition_column: str,
) -> list[str]:
    """Expand a base S3/path URI into one pattern per date for partition pruning."""
    base = base_uri.rstrip("/")
    dates = _dates_for_range(date_range)
    return [f"{base}/{partition_column}={d}/*.parquet" for d in dates]


def _build_parquet_source_relation(
    dataset_id: str,
    date_range: DateRange,
    required_columns: Iterable[str],
    source: datasets.DatasetSourceConfig,
) -> BaseRelation:
    uris = source.normalized_uris()
    # When we have a time_filter and a single base path (no glob), expand to date-partition paths
    # so DuckDB gets concrete file patterns (S3 prefix listing may not work like a directory).
    if (
        date_range is not None
        and
        source.time_filter is not None
        and len(uris) == 1
        and "*" not in uris[0]
    ):
        uris = _expand_date_partition_uris(
            uris[0],
            date_range,
            source.time_filter.column,
        )
    if source.max_files is not None and len(uris) > source.max_files:
        raise DatasetConfigError(
            dataset_id,
            "Source URI count exceeds configured max_files",
            {"max_files": source.max_files, "uri_count": len(uris)},
        )
    if not uris:
        raise DatasetConfigError(dataset_id, "Dataset source requires at least one URI")

    if len(uris) == 1:
        source_expr = f"read_parquet(?{_read_options_sql(dataset_id, source)})"
    else:
        placeholders = ", ".join("?" for _ in uris)
        source_expr = f"read_parquet([{placeholders}]{_read_options_sql(dataset_id, source)})"

    params: list[Any] = list(uris)
    cols = _ensure_columns(required_columns)
    projected = ", ".join(quote_identifier(c) for c in cols) if cols else "*"
    where_parts: list[str] = []
    handles_date = False
    requires_time_filter = False
    if source.time_filter is not None and date_range is not None:
        handles_date = True
        requires_time_filter = True
        where_parts.append(
            _time_filter_sql(
                source.time_filter.column,
                source.time_filter.type,
                date_range,
                params,
            )
        )
    where_clause = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""
    cte_sql = f"WITH base AS (SELECT {projected} FROM {source_expr}{where_clause})"
    return BaseRelation(
        cte_sql=cte_sql,
        from_sql="base",
        params=params,
        handles_date=handles_date,
        requires_time_filter=requires_time_filter,
    )


def _build_legacy_partition_relation(
    dataset_id: str,
    date_range: DateRange | None,
    required_columns: Iterable[str],
) -> BaseRelation:
    settings = get_settings()
    bucket = getattr(settings, "s3_bucket", None)
    base_path = getattr(settings, "partition_base_path", None)
    dates = _dates_for_range(date_range)

    if not bucket and not base_path:
        raise PartitionConfigError({"dataset_id": dataset_id})

    patterns: list[str] = []
    if base_path:
        root = Path(base_path)
        if dates:
            for d in dates:
                patterns.append(str(root / dataset_id / f"date={d}" / "*.parquet"))
        else:
            patterns.append(str(root / dataset_id / "date=*" / "*.parquet"))
    else:
        if dates:
            for d in dates:
                patterns.append(build_partition_path(bucket, dataset_id, d) + "*.parquet")
        else:
            patterns.append(f"s3://{bucket}/{dataset_id}/date=*/*.parquet")

    missing: list[str] = []
    if base_path:
        for d, pat in zip(dates, patterns):
            parent = Path(pat).parent
            if not any(parent.glob("*.parquet")):
                missing.append(d)
    if missing:
        raise PartitionNotFoundError(dataset_id, missing)

    placeholders = ", ".join("?" for _ in patterns)
    source_expr = f"read_parquet([{placeholders}])"

    cols = _ensure_columns(required_columns)
    projected = ", ".join(quote_identifier(c) for c in cols) if cols else "*"

    params: list[Any] = list(patterns)
    where_parts: list[str] = []
    date_clause_params: list[Any] = []
    if isinstance(date_range, DateRangeSingle):
        where_parts.append('"date" = ?')
        date_clause_params.append(date_range.date)
    elif isinstance(date_range, DateRangeRange):
        where_parts.append('"date" BETWEEN ? AND ?')
        date_clause_params.extend([date_range.start, date_range.end])

    params.extend(date_clause_params)
    where_clause = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""
    cte_sql = f"WITH base AS (SELECT {projected} FROM {source_expr}{where_clause})"
    return BaseRelation(cte_sql=cte_sql, from_sql="base", params=params, handles_date=True)


def required_relation_columns(dataset_id: str) -> set[str]:
    """Return implicit columns required by base-relation planning (e.g., time filters)."""
    settings = get_settings()
    if settings.execution_mode != "parquet_partitioned":
        return {"date"}
    source = datasets.get_dataset_source(dataset_id)
    if source is None:
        return {"date"}
    if source.time_filter is None:
        return set()
    return {source.time_filter.column}


def build_base_relation(
    dataset_id: str,
    date_range: DateRange | None,
    required_columns: Iterable[str],
) -> BaseRelation:
    """
    Build the base relation (FROM source) for a query.

    - sample_table: uses the seeded DuckDB table named after dataset_id
    - parquet_partitioned: reads partitioned parquet paths with projection pushdown
    """
    settings = get_settings()
    if settings.execution_mode == "parquet_partitioned":
        source = datasets.get_dataset_source(dataset_id)
        if source is not None:
            return _build_parquet_source_relation(dataset_id, date_range, required_columns, source)
        return _build_legacy_partition_relation(dataset_id, date_range, required_columns)

    quoted = quote_identifier(dataset_id)
    return BaseRelation(
        cte_sql=None,
        from_sql=quoted,
        params=[],
        handles_date=False,
        requires_time_filter=True,
    )
