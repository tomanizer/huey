"""
Health check endpoints for QueryService.

- /health/liveness: basic "up" check for process and load balancers.
- /health/readiness: readiness for traffic (verifies DuckDB engine connectivity).
"""

from fastapi import APIRouter

from server.engine import db_manager

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/liveness")
async def liveness() -> dict:
    """Basic liveness: process is running."""
    return {"status": "ok"}


@router.get("/readiness")
async def readiness() -> dict:
    """Readiness: service is ready to accept traffic (engine must be healthy)."""
    if not db_manager.health_check():
        return {"status": "unavailable"}
    return {"status": "ok"}
