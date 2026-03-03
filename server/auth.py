"""Authentication dependency for QueryService."""

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader

from server.config import get_settings

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def require_api_key(api_key: str = Security(api_key_header)) -> str:
    """
    Enforce API key authentication when enabled.

    Returns the provided key (or "anonymous" when auth disabled) for downstream use.
    """
    settings = get_settings()
    if not settings.auth_enabled:
        return "anonymous"
    if not api_key:
        raise HTTPException(status_code=401, detail="Missing API key")
    if api_key not in settings.api_key_list:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return api_key
