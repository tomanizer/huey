"""
Export endpoint: POST /export, GET /export/{id}, GET /export/{id}/download.

Delegates to ExportService for durable job management backed by SQLite.
Background processing is dispatched via FastAPI BackgroundTasks.
"""

import logging
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response
from fastapi.responses import FileResponse

from server import datasets
from server.auth import require_api_key
from server.config import get_settings
from server.engine import db_manager
from server.errors import DatasetNotFoundError, DatasetUnavailableError
from server.export_service import get_export_service
from server.models import ExportRequest, ExportResponse, ExportStatusResponse
from server.query_builder import validate_export_query_fields
from server.rate_limit import limiter
from server.request_context import set_request_id

logger = logging.getLogger("query_service.export")

router = APIRouter(prefix="/export", tags=["export"])


@router.post("", response_model=ExportResponse)
@limiter.limit(lambda: get_settings().rate_limit_export)
async def post_export(
    request: Request,
    body: ExportRequest,
    response: Response,
    background_tasks: BackgroundTasks,
    _api_key: str = Depends(require_api_key),
) -> ExportResponse:
    """POST /export: submit export job with background processing."""
    if body.client_context and body.client_context.request_id:
        rid = body.client_context.request_id
        set_request_id(rid)
        request.state.request_id = rid
    if datasets.get_schema(body.dataset_id) is None:
        raise DatasetNotFoundError(body.dataset_id)
    settings = get_settings()
    if settings.execution_mode == "sample_table" and not db_manager.table_exists(body.dataset_id):
        raise DatasetUnavailableError(body.dataset_id)
    validate_export_query_fields(body.query, datasets.get_schema_field_names(body.dataset_id))

    service = get_export_service()
    job = service.submit(body)
    background_tasks.add_task(service.process, job.id, body)
    return ExportResponse(export_id=job.id, status=job.status)


@router.get("/{export_id}", response_model=ExportStatusResponse)
async def get_export_status(export_id: str, _api_key: str = Depends(require_api_key)) -> ExportStatusResponse:
    """GET /export/{id}: return export job status (and download_url when complete)."""
    service = get_export_service()
    job = service.get_status(export_id)
    return ExportStatusResponse(
        export_id=job.id,
        status=job.status,
        download_url=job.download_url,
        row_count=job.row_count,
    )


@router.get("/{export_id}/download")
async def download_export(export_id: str, _api_key: str = Depends(require_api_key)) -> FileResponse:
    """GET /export/{id}/download: download the completed export file."""
    service = get_export_service()
    file_path = service.get_download_path(export_id)
    suffix = Path(file_path).suffix.lower()
    if suffix == ".parquet":
        media_type = "application/octet-stream"
        filename = f"{export_id}.parquet"
    elif suffix == ".sqlite":
        media_type = "application/vnd.sqlite3"
        filename = f"{export_id}.sqlite"
    elif suffix == ".duckdb":
        media_type = "application/vnd.duckdb"
        filename = f"{export_id}.duckdb"
    else:
        media_type = "text/csv"
        filename = f"{export_id}.csv"
    return FileResponse(
        path=file_path,
        filename=filename,
        media_type=media_type,
    )
