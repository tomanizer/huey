"""Shared test fixtures for backend tests."""

import pytest
from fastapi.testclient import TestClient

from server.datasets import load_sample_data
from server.engine import db_manager
from server.main import app


@pytest.fixture(autouse=True, scope="session")
def _init_test_db():
    """Initialize DuckDB with sample data once for the entire test session."""
    db_manager.initialize()
    load_sample_data(db_manager)
    yield
    db_manager.shutdown()


@pytest.fixture
def client() -> TestClient:
    """Shared TestClient for API tests."""
    return TestClient(app)
