"""Rate limiting helpers for QueryService."""

import hashlib
import ipaddress

from slowapi import Limiter
from starlette.requests import Request

from server.auth import is_valid_api_key
from server.config import get_settings


def _parse_ip(value: str) -> str | None:
    """Return canonical IP string when valid, otherwise None."""
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


def get_real_ip(request: Request) -> str:
    """Extract client IP using trusted proxy depth and common forwarding headers."""
    settings = get_settings()
    trusted_proxy_count = settings.trusted_proxy_count
    if trusted_proxy_count > 0:
        forwarded_for = request.headers.get("X-Forwarded-For")
        if forwarded_for:
            # Split the header into raw parts without filtering invalid IPs yet
            parts = [p.strip() for p in forwarded_for.split(",")]
            if len(parts) >= trusted_proxy_count:
                # Select the IP at the trusted depth from the right
                target_ip = parts[-trusted_proxy_count]
                parsed_ip = _parse_ip(target_ip)
                if parsed_ip:
                    return parsed_ip

        real_ip = request.headers.get("X-Real-IP")
        if real_ip:
            parsed_real_ip = _parse_ip(real_ip)
            if parsed_real_ip:
                return parsed_real_ip

    client = request.client
    return client.host if client else "unknown"


def get_rate_limit_key(request: Request) -> str:
    """Build a rate-limit key using API identity when configured, else client IP."""
    settings = get_settings()
    if settings.auth_enabled and settings.rate_limit_by_api_key:
        api_key = request.headers.get("X-API-Key", "")
        if is_valid_api_key(api_key, settings.api_key_list):
            digest = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]
            return f"key:{digest}"

    return f"ip:{get_real_ip(request)}"


def _make_limiter() -> Limiter:
    settings = get_settings()
    return Limiter(
        key_func=get_rate_limit_key,
        enabled=settings.rate_limit_enabled,
        headers_enabled=True,
    )


limiter = _make_limiter()  # module-level singleton
