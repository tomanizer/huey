"""Dimension cache prewarming for hot picklist fields.

Reads ``QUERYSERVICE_DIM_PREWARM_FIELDS`` (a CSV of ``dataset_id:field`` pairs)
and executes a picklist query for each field at startup, storing the results in
the dimension cache so the first real request is served from cache.
"""

import datetime
import logging
from typing import Any

logger = logging.getLogger("query_service.prewarm")


def _latest_partition_date(metadata: Any) -> str | None:
    """Return the most recent ISO partition date present in cached metadata."""
    if metadata is None:
        return None

    if isinstance(metadata, dict) and isinstance(metadata.get("partitions"), list):
        source = metadata.get("partitions", [])
    elif isinstance(metadata, dict):
        source = [{"date": key, "meta": value} for key, value in metadata.items()]
    elif isinstance(metadata, list):
        source = metadata
    else:
        source = [metadata]

    dates: list[str] = []
    for item in source:
        if not isinstance(item, dict):
            continue
        value = item.get("date") or item.get("partition_date")
        if not isinstance(value, str):
            continue
        try:
            normalized = datetime.date.fromisoformat(value).isoformat()
        except ValueError:
            continue
        dates.append(normalized)

    return max(dates) if dates else None


def _select_prewarm_date(dataset_id: str) -> tuple[str, str]:
    """Return the date to use for prewarming and the strategy that selected it."""
    from server.config import get_settings
    from server.datasets import get_partition_metadata

    settings = get_settings()
    configured_date = getattr(settings, "dim_prewarm_date", None)
    if configured_date:
        try:
            return datetime.date.fromisoformat(str(configured_date)).isoformat(), "configured"
        except ValueError:
            logger.warning(
                "Invalid configured prewarm date '%s'; falling back to date mode",
                configured_date,
                extra={"dataset_id": dataset_id, "configured_date": configured_date},
            )

    mode = str(getattr(settings, "dim_prewarm_date_mode", "latest_available") or "latest_available").strip().lower()
    if mode == "latest_available":
        latest_date = _latest_partition_date(get_partition_metadata(dataset_id))
        if latest_date:
            return latest_date, mode
        return datetime.date.today().isoformat(), "today_fallback"
    if mode != "today":
        logger.warning(
            "Unknown prewarm date mode '%s'; falling back to today",
            mode,
            extra={"dataset_id": dataset_id, "date_mode": mode},
        )
    return datetime.date.today().isoformat(), "today"


async def prewarm_dim_fields() -> None:
    """Execute picklist queries for configured hot fields and warm the cache.

    Called as a background task during application startup.  Failures are
    logged but never propagated so they cannot break the startup sequence.
    """
    # Defer all imports to avoid module-level circular dependency issues.
    from server.cache import build_cache_key, get_query_cache
    from server.config import get_settings
    from server.datasets import get_dim_version_token, get_schema_field_names
    from server.engine import db_manager
    from server.models import DateRangeSingle, PicklistQueryBody
    from server.query_builder import build_picklist_sql

    settings = get_settings()
    raw = getattr(settings, "dim_prewarm_fields", None)
    if not raw:
        return

    specs = [s.strip() for s in raw.split(",") if s.strip()]
    if not specs:
        return

    cache = await get_query_cache()
    warmed = 0

    for spec in specs:
        if ":" not in spec:
            logger.warning("Skipping invalid prewarm spec (expected dataset_id:field): %s", spec)
            continue

        dataset_id, field = spec.split(":", 1)

        schema_fields = get_schema_field_names(dataset_id)
        if not schema_fields:
            logger.warning("Skipping prewarm for unknown dataset: %s", dataset_id)
            continue
        if field not in schema_fields:
            logger.warning(
                "Skipping prewarm for unknown field '%s' in dataset '%s'",
                field,
                dataset_id,
            )
            continue

        selected_date: str | None = None
        date_strategy: str | None = None
        try:
            selected_date, date_strategy = _select_prewarm_date(dataset_id)
            date_range = DateRangeSingle(type="single", date=selected_date)
            query = PicklistQueryBody(field=field)
            sql, params = build_picklist_sql(dataset_id, query, date_range, schema_fields)
            rows = await db_manager.execute_sql_async(
                sql,
                tuple(params) if params else None,
                dataset_id=dataset_id,
            )

            if rows:
                total_count = int(rows[0][-1])
                values = [{"value": str(row[0]), "label": str(row[0])} for row in rows]
            else:
                total_count = 0
                values = []

            paging = {
                "limit": settings.picklist_default_limit,
                "offset": 0,
                "returned": len(values),
            }
            result = {
                "response": {"total_count": total_count, "values": values, "paging": paging},
                "duration_ms": 0.0,
                "row_count": len(rows) if rows else 0,
            }

            dim_token = get_dim_version_token(dataset_id)
            cache_key = build_cache_key(
                "picklist",
                dataset_id,
                date_range.model_dump(),
                query.model_dump(),
                dim_version_token=dim_token,
            )

            stale_ttl = float(getattr(settings, "dim_stale_ttl_seconds", 0))

            async def _loader(_r=result):
                return _r

            await cache.get_or_set(
                cache_key,
                _loader,
                ttl_seconds=float(settings.dim_cache_ttl_seconds),
                max_item_bytes=settings.cache_max_item_bytes,
                stale_ttl_seconds=stale_ttl,
            )
            warmed += 1
            logger.info(
                "Prewarmed dim cache for %s:%s on %s",
                dataset_id,
                field,
                selected_date,
                extra={
                    "dataset_id": dataset_id,
                    "field": field,
                    "selected_date": selected_date,
                    "date_strategy": date_strategy,
                    "warmed_count": warmed,
                    "row_count": len(values),
                },
            )
        except Exception:
            logger.exception(
                "Failed to prewarm dim cache for %s:%s",
                dataset_id,
                field,
                extra={
                    "dataset_id": dataset_id,
                    "field": field,
                    "selected_date": selected_date,
                    "date_strategy": date_strategy,
                    "warmed_count": warmed,
                },
            )

    logger.info(
        "Dimension cache prewarming complete (%d field(s))",
        warmed,
        extra={"warmed_count": warmed},
    )
