"""Rate limiting helpers for QueryService."""

from starlette.requests import Request


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
