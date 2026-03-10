"""
Contextvars-based request metadata propagation.

Request-scoped metadata such as the correlation ID and client version
is set by middleware and flows through the request lifecycle for
logging and tracing.
"""

import contextvars
import uuid

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id", default=""
)
client_version_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "client_version", default=""
)


def get_request_id() -> str:
    """Return the current request's correlation ID."""
    return request_id_var.get()


def set_request_id(request_id: str) -> contextvars.Token:
    """Set the correlation ID for the current request context."""
    return request_id_var.set(request_id)


def get_client_version() -> str:
    """Return the current request's client version header value, if any."""
    return client_version_var.get()


def set_client_version(client_version: str) -> contextvars.Token:
    """Set the client version for the current request context."""
    return client_version_var.set(client_version)


def generate_request_id() -> str:
    """Generate a short unique request ID."""
    return str(uuid.uuid4())[:8]
