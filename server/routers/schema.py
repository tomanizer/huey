"""
Schema endpoint under /api/v1/datasets/{dataset_id}/schema.
"""

from fastapi import APIRouter, Depends

from server import datasets
from server.auth import require_api_key
from server.errors import DatasetNotFoundError

router = APIRouter(tags=["schema"])


@router.get("/schema")
async def get_schema(dataset_id: str, _api_key: str = Depends(require_api_key)) -> dict:
    """
    Fetch schema metadata for a dataset.
    GET /api/v1/datasets/{dataset_id}/schema
    """
    schema = datasets.get_schema(dataset_id)
    if schema is None:
        raise DatasetNotFoundError(dataset_id)
    return schema
