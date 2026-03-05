"""
Health check endpoints for QueryService.

- /health/liveness: basic "up" check for process and load balancers.
- /health/readiness: readiness for traffic (verifies DuckDB engine connectivity).
- /health/ready: alias for /health/readiness (Docker HEALTHCHECK, K8s, etc.).
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from server.engine import db_manager

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/liveness")
async def liveness() -> dict:
    """Basic liveness: process is running."""
    return {"status": "ok"}


@router.get("/readiness")
async def readiness() -> JSONResponse:
    """Readiness: service is ready to accept traffic (engine must be healthy)."""
    if not db_manager.health_check():
        return JSONResponse(status_code=503, content={"status": "unavailable"})
    return JSONResponse(status_code=200, content={"status": "ok"})


@router.get("/ready")
async def ready() -> JSONResponse:
    """Alias for /health/readiness (e.g. Docker HEALTHCHECK, Kubernetes)."""
    return await readiness()
