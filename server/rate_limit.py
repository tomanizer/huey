"""Rate limiting helpers for QueryService."""

from slowapi import Limiter
from starlette.requests import Request

from server.config import get_settings


def get_real_ip(request: Request) -> str:
    """Extract client IP using trusted proxy depth and common forwarding headers."""
    settings = get_settings()
    trusted_proxy_count = settings.trusted_proxy_count
    if trusted_proxy_count > 0:
        forwarded_for = request.headers.get("X-Forwarded-For")
        if forwarded_for:
            forwarded_ips = [ip.strip() for ip in forwarded_for.split(",") if ip.strip()]
            if len(forwarded_ips) >= trusted_proxy_count:
                return forwarded_ips[-trusted_proxy_count]

        real_ip = request.headers.get("X-Real-IP")
        if real_ip:
            return real_ip.strip()

    client = request.client
    return client.host if client else "unknown"


def get_rate_limit_key(request: Request) -> str:
    """Build a rate-limit key using API identity when configured, else client IP."""
    settings = get_settings()
    if settings.auth_enabled and settings.rate_limit_by_api_key:
        api_key = request.headers.get("X-API-Key", "")
        if api_key:
            return f"key:{api_key}"

    return f"ip:{get_real_ip(request)}"


def _make_limiter() -> Limiter:
    settings = get_settings()
    return Limiter(
        key_func=get_rate_limit_key,
        enabled=settings.rate_limit_enabled,
        headers_enabled=True,
    )


limiter = _make_limiter()  # module-level singleton
