"""Authentication dependency for QueryService."""

import hmac

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader

from server.config import get_settings

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def _constant_time_key_check(provided: str, valid_keys: list[str]) -> bool:
    """Compare provided key against all valid keys in constant time.

    Iterates all keys without short-circuiting to prevent timing oracles
    that could be used to enumerate valid key prefixes.
    """
    provided_bytes = provided.encode()
    matched = False
    for key in valid_keys:
        if hmac.compare_digest(key.encode(), provided_bytes):
            matched = True
    return matched


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
    if not _constant_time_key_check(api_key, settings.api_key_list):
        raise HTTPException(status_code=401, detail="Invalid API key")
    return api_key
