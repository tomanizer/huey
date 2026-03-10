"""
Health check endpoints for QueryService.

- /health/liveness: basic "up" check for process and load balancers.
- /health/readiness: readiness for traffic (verifies DuckDB engine connectivity).
- /health/ready: alias for /health/readiness (Docker HEALTHCHECK, K8s, etc.).
"""

import asyncio

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from server.engine import db_manager

router = APIRouter(prefix="/health", tags=["health"])
startup_complete_event = asyncio.Event()


def mark_startup_complete() -> None:
    """Mark startup prewarm state as complete."""
    startup_complete_event.set()


def reset_startup_complete() -> None:
    """Reset startup prewarm state."""
    startup_complete_event.clear()


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


@router.get("/startup")
async def startup() -> JSONResponse:
    """Startup probe: 200 when prewarm is complete, 503 otherwise."""
    if startup_complete_event.is_set():
        return JSONResponse(status_code=200, content={"status": "ok"})
    return JSONResponse(status_code=503, content={"status": "starting"})
