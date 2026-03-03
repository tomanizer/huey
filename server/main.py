"""
QueryService – Huey OLAP backend.

FastAPI application with health endpoints, config loader, and structured logging.
"""
# ruff: noqa: E402

import asyncio
import logging
from contextlib import asynccontextmanager

# Fail fast with a clear message before importing modules that require modern syntax.
from server.runtime import ensure_supported_python

ensure_supported_python()

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from server.config import get_settings
from server.datasets import load_sample_data
from server.engine import db_manager
from server.errors import AppError, ErrorResponse
from server.export_service import init_export_service
from server.export_store import ExportJobStore
from server.logging_config import setup_logging
from server.middleware import AccessLogMiddleware, CorrelationIdMiddleware
from server.query_budget import get_query_budget
from server.rate_limit import get_real_ip
from server.request_context import get_request_id

settings = get_settings()
setup_logging(settings.log_level, settings.log_format)
logger = logging.getLogger("query_service")

limiter = Limiter(
    key_func=get_real_ip,
    enabled=settings.rate_limit_enabled,
    headers_enabled=True,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize engine and export store on startup, cleanly shut them down on exit."""
    logger.info("QueryService starting", extra={"host": settings.host, "port": settings.port})
    db_manager.initialize()
    load_sample_data(db_manager)

    export_store = ExportJobStore(settings.export_db_path)
    export_store.initialize()
    svc = init_export_service(export_store)
    recovered = svc.recover_stale_jobs()
    if recovered:
        logger.info("Recovered stale export jobs", extra={"count": recovered})

    yield

    drain_seconds = settings.shutdown_drain_seconds
    logger.info("QueryService draining in-flight queries", extra={"drain_seconds": drain_seconds})
    budget = get_query_budget()
    deadline = asyncio.get_event_loop().time() + drain_seconds
    while budget.active_count > 0:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            logger.warning(
                "Shutdown drain timeout — forcing close with active queries",
                extra={"active_queries": budget.active_count},
            )
            break
        await asyncio.sleep(0.1)

    export_store.close()
    db_manager.shutdown()
    logger.info("QueryService shutdown complete")


app = FastAPI(
    title="QueryService",
    description="Huey OLAP query service for S3-backed parquet datasets. Set X-API-Key header when authentication is enabled.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(AccessLogMiddleware)
app.add_middleware(CorrelationIdMiddleware)
app.add_middleware(SlowAPIMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

from server.routers import export, health, query, schema  # noqa: E402

app.include_router(export.router)
app.include_router(health.router)
app.include_router(query.router)
app.include_router(schema.router)


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    """Map domain errors to structured HTTP responses with consistent codes."""
    body = ErrorResponse(
        code=exc.code,
        message=exc.message,
        request_id=get_request_id() or None,
        details=exc.details,
    )
    logger.warning(
        "Domain error: %s",
        exc.code,
        extra={"error_code": exc.code, "status_code": exc.status_code},
    )
    return JSONResponse(status_code=exc.status_code, content=body.model_dump(exclude_none=True))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Normalize FastAPI validation errors into the ErrorResponse envelope."""
    clean_errors = []
    for err in exc.errors():
        entry = {
            "loc": list(err.get("loc", [])),
            "msg": err.get("msg", ""),
            "type": err.get("type", ""),
        }
        clean_errors.append(entry)
    body = ErrorResponse(
        code="VALIDATION_ERROR",
        message="Request validation failed",
        request_id=get_request_id() or None,
        details={"errors": clean_errors},
    )
    return JSONResponse(status_code=422, content=body.model_dump(exclude_none=True))


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all handler to avoid leaking stack traces to clients."""
    logger.exception("Unhandled exception")
    body = ErrorResponse(
        code="INTERNAL_ERROR",
        message="An unexpected error occurred",
        request_id=get_request_id() or None,
    )
    return JSONResponse(status_code=500, content=body.model_dump(exclude_none=True))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "server.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )
