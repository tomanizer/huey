"""Dataset discovery endpoints under /api/v1/datasets."""

from __future__ import annotations

import base64
import binascii
from typing import Any

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse

from server import datasets
from server.auth import require_api_key
from server.config import get_settings
from server.errors import DatasetNotFoundError, ValidationAppError
from server.rate_limit import limiter

router = APIRouter(prefix="/datasets", tags=["datasets"])


def _encode_cursor(offset: int | None) -> str | None:
    if offset is None:
        return None
    return base64.urlsafe_b64encode(str(offset).encode("utf-8")).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        padding = "=" * (-len(cursor) % 4)
        decoded = base64.urlsafe_b64decode((cursor + padding).encode("ascii")).decode("utf-8")
        offset = int(decoded)
    except (binascii.Error, ValueError) as exc:  # pragma: no cover - defensive
        raise ValidationAppError(
            [
                {
                    "loc": ["query", "cursor"],
                    "msg": "Invalid cursor",
                    "type": "value_error.invalid_cursor",
                }
            ]
        ) from exc
    if offset < 0:
        raise ValidationAppError(
            [
                {
                    "loc": ["query", "cursor"],
                    "msg": "Invalid cursor",
                    "type": "value_error.invalid_cursor",
                }
            ]
        )
    return offset


def _dataset_cache_headers(dataset_id: str) -> dict[str, str]:
    return {
        "ETag": datasets.get_dataset_etag(dataset_id),
        "Cache-Control": "private, max-age=60",
    }


def _not_modified_if_match(request: Request, dataset_id: str) -> Response | None:
    etag = datasets.get_dataset_etag(dataset_id)
    if request.headers.get("If-None-Match") == etag:
        return Response(status_code=304, headers=_dataset_cache_headers(dataset_id))
    return None


@router.get("")
@limiter.limit(lambda: get_settings().rate_limit_query)
async def list_datasets(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None),
    _api_key: str = Depends(require_api_key),
) -> dict[str, Any]:
    """GET /api/v1/datasets."""
    offset = _decode_cursor(cursor)
    all_entries = datasets.list_dataset_entries()
    total_count = len(all_entries)
    window = all_entries[offset : offset + limit]
    items = [datasets.get_dataset_summary(str(entry["dataset_id"])) for entry in window]
    next_offset = offset + limit if (offset + limit) < total_count else None
    return {
        "items": [item for item in items if item is not None],
        "cursor": _encode_cursor(next_offset),
        "total_count": total_count,
    }


@router.get("/{dataset_id}")
@limiter.limit(lambda: get_settings().rate_limit_query)
async def get_dataset(
    request: Request,
    dataset_id: str,
    _api_key: str = Depends(require_api_key),
) -> Response:
    """GET /api/v1/datasets/{dataset_id}."""
    cached = _not_modified_if_match(request, dataset_id)
    if cached is not None:
        return cached
    details = datasets.get_dataset_details(dataset_id)
    if details is None:
        raise DatasetNotFoundError(dataset_id)
    return JSONResponse(content=details, headers=_dataset_cache_headers(dataset_id))


@router.get("/{dataset_id}/schema")
@limiter.limit(lambda: get_settings().rate_limit_query)
async def get_dataset_schema(
    request: Request,
    dataset_id: str,
    _api_key: str = Depends(require_api_key),
) -> Response:
    """GET /api/v1/datasets/{dataset_id}/schema."""
    cached = _not_modified_if_match(request, dataset_id)
    if cached is not None:
        return cached
    schema = datasets.get_discovery_schema(dataset_id)
    if schema is None:
        raise DatasetNotFoundError(dataset_id)
    return JSONResponse(content=schema, headers=_dataset_cache_headers(dataset_id))
