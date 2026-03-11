"""Dimension cache prewarming for hot members fields.

Reads ``QUERYSERVICE_DIM_PREWARM_FIELDS`` (a CSV of ``dataset_id:field`` pairs)
and executes a members query for each field at startup, storing the results in
the dimension cache so the first real request is served from cache.
"""

import datetime
import logging

logger = logging.getLogger("query_service.prewarm")


async def prewarm_dim_fields() -> None:
    """Execute members queries for configured hot fields and warm the cache.

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
    today = datetime.date.today().isoformat()
    date_range = DateRangeSingle(type="single", date=today)
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

        try:
            query = PicklistQueryBody(field=field)
            sql, params = build_picklist_sql(dataset_id, query, date_range, schema_fields)
            rows = await db_manager.execute_sql_async(
                sql,
                tuple(params) if params else None,
                dataset_id=dataset_id,
            )

            if rows:
                total_count = int(rows[0][-1])
                items = [{"value": row[0], "count": int(row[1])} for row in rows]
            else:
                total_count = 0
                items = []

            paging = {
                "limit": settings.picklist_default_limit,
                "offset": 0,
                "returned": len(items),
            }
            result = {
                "response": {"field": query.field, "total_count": total_count, "items": items, "paging": paging},
                "duration_ms": 0.0,
                "row_count": len(rows) if rows else 0,
            }

            dim_token = get_dim_version_token(dataset_id)
            cache_key = build_cache_key(
                "members",
                dataset_id,
                date_range.model_dump(),
                query.model_dump(),
                data_token=dim_token,
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
                "Prewarmed dim cache for %s:%s",
                dataset_id,
                field,
                extra={"dataset_id": dataset_id, "field": field},
            )
        except Exception:
            logger.exception(
                "Failed to prewarm dim cache for %s:%s",
                dataset_id,
                field,
                extra={"dataset_id": dataset_id, "field": field},
            )

    logger.info(
        "Dimension cache prewarming complete (%d field(s))",
        warmed,
        extra={"warmed_count": warmed},
    )
