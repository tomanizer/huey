"""
Contextvars-based request context for correlation ID propagation.

The request ID is set by CorrelationIdMiddleware and flows through
the entire request lifecycle for logging and tracing.
"""

import contextvars
import uuid

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id", default=""
)


def get_request_id() -> str:
    """Return the current request's correlation ID."""
    return request_id_var.get()


def set_request_id(request_id: str) -> contextvars.Token:
    """Set the correlation ID for the current request context."""
    return request_id_var.set(request_id)


def generate_request_id() -> str:
    """Generate a short unique request ID."""
    return str(uuid.uuid4())[:8]
