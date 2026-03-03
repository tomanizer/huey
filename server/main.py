"""
QueryService – Huey OLAP backend.

FastAPI application with health endpoints, config loader, and structured logging.
"""

import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.config import get_settings
from server.datasets import load_sample_data
from server.engine import db_manager
from server.routers import export, health, query, schema


# Configure logging before creating app
def _setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stdout,
    )


settings = get_settings()
_setup_logging(settings.log_level)
logger = logging.getLogger("query_service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("QueryService starting", extra={"host": settings.host, "port": settings.port})
    db_manager.initialize()
    load_sample_data(db_manager)
    yield
    db_manager.shutdown()
    logger.info("QueryService shutting down")


app = FastAPI(
    title="QueryService",
    description="Huey OLAP query service for S3-backed parquet datasets",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8765", "http://127.0.0.1:8765", "http://localhost:8080", "http://127.0.0.1:8080"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(export.router)
app.include_router(health.router)
app.include_router(query.router)
app.include_router(schema.router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "server.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )
