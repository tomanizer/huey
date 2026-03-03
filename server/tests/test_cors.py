"""Integration-style tests for CORS configuration behavior."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from server.config import Settings


def _build_app(cors_origins: str) -> FastAPI:
    settings = Settings(cors_origins=cors_origins)
    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    @app.get("/ping")
    async def ping() -> dict[str, str]:
        return {"status": "ok"}

    return app


def test_cors_allows_configured_origin() -> None:
    app = _build_app("https://app.example.com,https://admin.example.com")
    with TestClient(app) as client:
        r = client.options(
            "/ping",
            headers={
                "Origin": "https://app.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "https://app.example.com"


def test_cors_blocks_unconfigured_origin() -> None:
    app = _build_app("https://app.example.com")
    with TestClient(app) as client:
        r = client.options(
            "/ping",
            headers={
                "Origin": "https://untrusted.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
    assert r.status_code == 400
    assert "access-control-allow-origin" not in r.headers
