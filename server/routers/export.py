"""
Export endpoint: POST /export, GET /export/{id} (MVP).
"""

import uuid

from fastapi import APIRouter, HTTPException

from server import datasets
from server.models import ExportRequest, ExportResponse, ExportStatusResponse

router = APIRouter(prefix="/export", tags=["export"])

_exports: dict[str, dict] = {}


@router.post("", response_model=ExportResponse)
async def post_export(body: ExportRequest) -> ExportResponse:
    """
    POST /export: submit export job. MVP returns pending; no background processing.
    """
    if datasets.get_schema(body.dataset_id) is None:
        raise HTTPException(status_code=404, detail=f"Dataset not found: {body.dataset_id}")

    export_id = "exp-" + str(uuid.uuid4())[:8]
    _exports[export_id] = {"status": "pending", "dataset_id": body.dataset_id}
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
