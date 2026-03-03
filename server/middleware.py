"""Request middleware for QueryService."""

import logging
import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from server.request_context import generate_request_id, set_request_id

logger = logging.getLogger("query_service.access")


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    """Extract or generate a correlation ID and attach it to the response.

    The ID is stored on request.state so route handlers can override it
    (e.g. from client_context.request_id) and the override propagates
    back to the response header.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        """Assign a correlation ID for the request and propagate it to the response."""
        request_id = request.headers.get("X-Request-ID") or generate_request_id()
        request.state.request_id = request_id
        set_request_id(request_id)

        response = await call_next(request)
        response.headers["X-Request-ID"] = getattr(
            request.state, "request_id", request_id
        )
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
            },
        )
        return response
