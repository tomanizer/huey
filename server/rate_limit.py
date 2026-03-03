"""Rate limiting helpers for QueryService."""

from slowapi import Limiter
from starlette.requests import Request

from server.config import get_settings


def get_real_ip(request: Request) -> str:
    """Extract the real client IP, honouring common proxy forwarding headers.

    Checks X-Forwarded-For (first entry) and X-Real-IP before falling back to
    the direct connection address. Deploy behind a trusted reverse proxy only.
    """
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    real_ip = request.headers.get("X-Real-IP")
    if real_ip:
        return real_ip.strip()
    client = request.client
    return client.host if client else "unknown"


def _make_limiter() -> Limiter:
    settings = get_settings()
    return Limiter(
        key_func=get_real_ip,
        enabled=settings.rate_limit_enabled,
        headers_enabled=True,
    )


limiter = _make_limiter()
