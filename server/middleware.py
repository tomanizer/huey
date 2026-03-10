"""Request middleware for QueryService."""

import logging
import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from server.request_context import generate_request_id, set_client_version, set_request_id

logger = logging.getLogger("query_service.access")


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    """Extract or generate a correlation ID and attach it to the response.

    The ID and optional client version are stored on request.state and
    reflected back through response/logging metadata.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        """Assign a correlation ID for the request and propagate it to the response."""
        request_id = request.headers.get("X-Request-ID") or generate_request_id()
        client_version = request.headers.get("X-Client-Version", "")
        request.state.request_id = request_id
        request.state.client_version = client_version
        set_request_id(request_id)
        set_client_version(client_version)

        response = await call_next(request)
        response.headers["X-Request-ID"] = getattr(
            request.state, "request_id", request_id
        )
        response.headers["X-API-Version"] = "1"
        return response


class AccessLogMiddleware(BaseHTTPMiddleware):
    """Log method, path, status code, and duration for every request."""

    async def dispatch(self, request: Request, call_next) -> Response:
        """Emit a structured access log entry for each request/response pair."""
        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - start) * 1000

        logger.info(
            "%s %s %d (%.1fms)",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
            extra={
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": round(duration_ms, 2),
                "client_ip": request.client.host if request.client else None,
                "client_version": getattr(request.state, "client_version", ""),
            },
        )
        return response
