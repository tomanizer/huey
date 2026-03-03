"""
Export endpoint: POST /export, GET /export/{id}, GET /export/{id}/download.

Supports background processing via FastAPI BackgroundTasks, TTL-based cleanup,
and a configurable max concurrent export limit.
"""

import csv
import logging
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import FileResponse

from server import datasets
from server.config import get_settings
from server.engine import db_manager
from server.models import ExportRequest, ExportResponse, ExportStatusResponse
from server.query_builder import build_export_sql
from server.request_context import set_request_id

logger = logging.getLogger("query_service.export")

router = APIRouter(prefix="/export", tags=["export"])

_exports: dict[str, dict] = {}


def _cleanup_expired() -> None:
    """Remove exports older than TTL and delete their files."""
    settings = get_settings()
    now = time.time()
    expired = [
        k for k, v in _exports.items()
        if now - v.get("created_at", 0) > settings.export_ttl_seconds
    ]
    for k in expired:
        job = _exports.pop(k, None)
        if job and job.get("file_path"):
            Path(job["file_path"]).unlink(missing_ok=True)
            logger.info("Expired export cleaned up", extra={"export_id": k})


def _active_count() -> int:
    """Count exports currently in pending or processing state."""
    return sum(
        1 for v in _exports.values()
        if v.get("status") in ("pending", "processing")
    )


def _process_export(export_id: str, body: ExportRequest) -> None:
    """Background task: run query, write CSV, update status."""
    try:
        _exports[export_id]["status"] = "processing"
        settings = get_settings()
        output_dir = Path(settings.export_output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        file_path = output_dir / f"{export_id}.csv"

        schema_fields = datasets.get_schema_field_names(body.dataset_id)
        sql, params, headers = build_export_sql(
            body.dataset_id, body.query, body.date_range, schema_fields,
        )

        rows = db_manager.execute_sql(sql, params)

        with open(file_path, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(headers)
            for row in rows:
                writer.writerow(row)

        row_count = len(rows) if rows else 0
        _exports[export_id]["status"] = "complete"
        _exports[export_id]["file_path"] = str(file_path)
        _exports[export_id]["row_count"] = row_count
        _exports[export_id]["download_url"] = f"/export/{export_id}/download"
        logger.info(
            "Export complete",
            extra={"export_id": export_id, "row_count": row_count},
        )
    except Exception:
        _exports[export_id]["status"] = "failed"
        logger.exception("Export failed", extra={"export_id": export_id})


@router.post("", response_model=ExportResponse)
async def post_export(
    body: ExportRequest,
    request: Request,
    background_tasks: BackgroundTasks,
) -> ExportResponse:
    """POST /export: submit export job with background processing."""
    if body.client_context and body.client_context.request_id:
        rid = body.client_context.request_id
        set_request_id(rid)
        request.state.request_id = rid
    if datasets.get_schema(body.dataset_id) is None:
        raise HTTPException(status_code=404, detail=f"Dataset not found: {body.dataset_id}")

    _cleanup_expired()

    settings = get_settings()
    if _active_count() >= settings.export_max_concurrent:
        raise HTTPException(
            status_code=429,
            detail=f"Too many concurrent exports (max {settings.export_max_concurrent})",
        )

    export_id = "exp-" + str(uuid.uuid4())[:8]
    _exports[export_id] = {
        "status": "pending",
        "dataset_id": body.dataset_id,
        "created_at": time.time(),
    }
    background_tasks.add_task(_process_export, export_id, body)
    return ExportResponse(export_id=export_id, status="pending")


@router.get("/{export_id}", response_model=ExportStatusResponse)
async def get_export_status(export_id: str) -> ExportStatusResponse:
    """GET /export/{id}: return export job status (and download_url when complete)."""
    if export_id not in _exports:
        raise HTTPException(status_code=404, detail="Export not found")
    job = _exports[export_id]
    return ExportStatusResponse(
        export_id=export_id,
        status=job.get("status", "pending"),
        download_url=job.get("download_url"),
    )


@router.get("/{export_id}/download")
async def download_export(export_id: str) -> FileResponse:
    """GET /export/{id}/download: download the completed export file."""
    if export_id not in _exports:
        raise HTTPException(status_code=404, detail="Export not found")
    job = _exports[export_id]
    if job.get("status") != "complete":
        raise HTTPException(status_code=409, detail=f"Export not ready (status: {job.get('status')})")
    file_path = job.get("file_path")
    if not file_path or not Path(file_path).exists():
        raise HTTPException(status_code=404, detail="Export file not found")
    return FileResponse(
        path=file_path,
        filename=f"{export_id}.csv",
        media_type="text/csv",
    )
