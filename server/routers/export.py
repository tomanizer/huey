"""
Export endpoints under /api/v1.

Delegates to ExportService for durable job management backed by SQLite.
Background processing is dispatched via FastAPI BackgroundTasks.
"""

import logging
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request, Response, status
from fastapi.responses import FileResponse

from server import datasets
from server.auth import require_api_key
from server.config import get_settings
from server.engine import db_manager
from server.errors import DatasetNotFoundError, DatasetUnavailableError
from server.export_service import get_export_service
from server.export_store import ExportJob
from server.models import (
    ExportLinks,
    ExportListItem,
    ExportListResponse,
    ExportRequest,
    ExportResponse,
    ExportStatusResponse,
    ExportSubmitRequest,
)
from server.query_builder import validate_export_query_fields
from server.rate_limit import limiter

logger = logging.getLogger("query_service.export")

router = APIRouter(tags=["export"])


def _export_links(export_id: str) -> ExportLinks:
    return ExportLinks(
        self=f"/api/v1/exports/{export_id}",
        file=f"/api/v1/exports/{export_id}/file",
    )


def _iso_timestamp(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _expires_at(created_at: float) -> str:
    return _iso_timestamp(created_at + get_settings().export_ttl_seconds)


def _file_response(file_path: str, export_id: str) -> FileResponse:
    suffix = file_path.rsplit(".", 1)[-1].lower()
    if suffix == "parquet":
        media_type = "application/octet-stream"
        filename = f"{export_id}.parquet"
    elif suffix == "sqlite":
        media_type = "application/vnd.sqlite3"
        filename = f"{export_id}.sqlite"
    elif suffix == "duckdb":
        media_type = "application/vnd.duckdb"
        filename = f"{export_id}.duckdb"
    elif suffix == "ndjson":
        media_type = "application/x-ndjson"
        filename = f"{export_id}.ndjson"
    else:
        media_type = "text/csv"
        filename = f"{export_id}.csv"
    return FileResponse(path=file_path, filename=filename, media_type=media_type)


def _status_response(job: ExportJob) -> ExportStatusResponse:
    links = _export_links(job.id)
    return ExportStatusResponse(
        export_id=job.id,
        dataset_id=job.dataset_id,
        status=job.status,
        format=job.format,
        created_at=_iso_timestamp(job.created_at),
        expires_at=_expires_at(job.created_at),
        download_url=job.download_url,
        row_count=job.row_count,
        size_bytes=job.size_bytes,
        completed_at=_iso_timestamp(job.completed_at) if job.completed_at is not None else None,
        progress_pct=None,
        links=links,
    )


def _list_item(job: ExportJob) -> ExportListItem:
    return ExportListItem(
        export_id=job.id,
        dataset_id=job.dataset_id,
        status=job.status,
        format=job.format,
        row_count=job.row_count,
        size_bytes=job.size_bytes,
        created_at=_iso_timestamp(job.created_at),
        expires_at=_expires_at(job.created_at),
        links=_export_links(job.id),
    )


@router.post("/datasets/{dataset_id}/exports", response_model=ExportResponse, status_code=status.HTTP_202_ACCEPTED)
@limiter.limit(lambda: get_settings().rate_limit_export)
async def post_export(
    request: Request,
    response: Response,
    dataset_id: str,
    body: ExportSubmitRequest,
    background_tasks: BackgroundTasks,
    _api_key: str = Depends(require_api_key),
) -> ExportResponse:
    """POST /api/v1/datasets/{dataset_id}/exports."""
    if datasets.get_schema(dataset_id) is None:
        raise DatasetNotFoundError(dataset_id)
    settings = get_settings()
    if settings.execution_mode == "sample_table" and not db_manager.table_exists(dataset_id):
        raise DatasetUnavailableError(dataset_id)
    validate_export_query_fields(dataset_id, body.query, datasets.get_schema_field_names(dataset_id))

    export_request = ExportRequest(dataset_id=dataset_id, date_range=body.date_range, query=body.query)
    service = get_export_service()
    job = service.submit(export_request)
    background_tasks.add_task(service.process, job.id, export_request)
    return ExportResponse(
        export_id=job.id,
        dataset_id=job.dataset_id,
        status=job.status,
        links=_export_links(job.id),
    )


@router.get("/exports", response_model=ExportListResponse)
@limiter.limit(lambda: get_settings().rate_limit_export)
async def list_exports(
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    status_filter: Literal["pending", "processing", "complete", "failed", "expired", "cancelled"] | None = Query(
        default=None,
        alias="status",
    ),
    _api_key: str = Depends(require_api_key),
) -> ExportListResponse:
    """GET /api/v1/exports."""
    service = get_export_service()
    jobs, next_cursor = service.list_exports(limit=limit, cursor=cursor, status=status_filter)
    return ExportListResponse(items=[_list_item(job) for job in jobs], cursor=next_cursor)


@router.get("/exports/{export_id}", response_model=ExportStatusResponse)
@limiter.limit(lambda: get_settings().rate_limit_export)
async def get_export_status(request: Request, export_id: str, _api_key: str = Depends(require_api_key)) -> ExportStatusResponse:
    """GET /api/v1/exports/{export_id}."""
    service = get_export_service()
    job = service.get_status(export_id)
    return _status_response(job)


@router.delete("/exports/{export_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit(lambda: get_settings().rate_limit_export)
async def delete_export(request: Request, export_id: str, _api_key: str = Depends(require_api_key)) -> Response:
    """DELETE /api/v1/exports/{export_id}."""
    service = get_export_service()
    service.delete_export(export_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/exports/{export_id}/file")
@limiter.limit(lambda: get_settings().rate_limit_export)
async def download_export(request: Request, export_id: str, _api_key: str = Depends(require_api_key)) -> FileResponse:
    """GET /api/v1/exports/{export_id}/file."""
    service = get_export_service()
    file_path = service.get_download_path(export_id)
    return _file_response(file_path, export_id)


@router.head("/exports/{export_id}/file")
@limiter.limit(lambda: get_settings().rate_limit_export)
async def head_export_file(request: Request, export_id: str, _api_key: str = Depends(require_api_key)) -> FileResponse:
    """HEAD /api/v1/exports/{export_id}/file."""
    service = get_export_service()
    file_path = service.get_download_path(export_id)
    return _file_response(file_path, export_id)
