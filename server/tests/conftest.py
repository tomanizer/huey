"""Shared test fixtures for backend tests."""

import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch

from server.config import get_settings
from server.datasets import load_sample_data
from server.engine import db_manager
from server.export_service import init_export_service
from server.export_store import ExportJobStore
from server.main import app


@pytest.fixture(autouse=True, scope="session")
def _init_test_db():
    """Initialize DuckDB and export service once for the entire test session."""
    db_manager.initialize()
    settings = get_settings()
    with patch("server.datasets.get_settings") as mock_settings:
        mock_settings.return_value = type("S", (), {
            "datasets_config_path": settings.datasets_config_path,
            "seed_sample_data": True,
        })()
        load_sample_data(db_manager)

    store = ExportJobStore(":memory:")
    store.initialize()
    init_export_service(store)

    yield

    store.close()
    db_manager.shutdown()


@pytest.fixture(autouse=True)
def _disable_auth(monkeypatch):
    """Disable authentication by default for tests."""
    monkeypatch.setenv("QUERYSERVICE_AUTH_ENABLED", "false")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client() -> TestClient:
    """Shared TestClient for API tests."""
    return TestClient(app)


@pytest.fixture
def auth_client(monkeypatch) -> TestClient:
    """Client with authentication enabled and a known API key."""
    monkeypatch.setenv("QUERYSERVICE_AUTH_ENABLED", "true")
    monkeypatch.setenv("QUERYSERVICE_API_KEYS", "test-key-123")
    get_settings.cache_clear()
    return TestClient(app)
