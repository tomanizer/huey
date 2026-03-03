"""
Base relation builder for query execution.

Provides a partition-aware parquet relation when configured, otherwise
falls back to the seeded sample tables.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable

from server.config import get_settings
from server.errors import PartitionConfigError, PartitionNotFoundError
from server.models import DateRange, DateRangeRange, DateRangeSingle
from server.s3 import build_partition_path
from server.utils import quote_identifier


@dataclass
class BaseRelation:
    """Represents the FROM source for query builders."""

    cte_sql: str | None
    from_sql: str
    params: list[Any]
    handles_date: bool


def _dates_for_range(date_range: DateRange) -> list[str]:
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


def _build_parquet_partition_relation(
    dataset_id: str,
    date_range: DateRange,
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
        for d in dates:
            patterns.append(str(root / dataset_id / f"date={d}" / "*.parquet"))
    else:
        for d in dates:
            patterns.append(build_partition_path(bucket, dataset_id, d) + "*.parquet")

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


def build_base_relation(
    dataset_id: str,
    date_range: DateRange,
    required_columns: Iterable[str],
) -> BaseRelation:
    """
    Build the base relation (FROM source) for a query.

    - sample_table: uses the seeded DuckDB table named after dataset_id
    - parquet_partitioned: reads partitioned parquet paths with projection pushdown
    """
    settings = get_settings()
    mode = getattr(settings, "execution_mode", "sample_table")
    if mode == "parquet_partitioned":
        return _build_parquet_partition_relation(dataset_id, date_range, required_columns)

    quoted = quote_identifier(dataset_id)
    return BaseRelation(cte_sql=None, from_sql=quoted, params=[], handles_date=False)
