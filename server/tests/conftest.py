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


@pytest.fixture
def valid_date_range() -> dict:
    return {"type": "single", "date": "2026-03-01"}


@pytest.fixture
def valid_tuples_body() -> dict:
    return {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"axis": "rows", "fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 0}},
    }
