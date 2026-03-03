"""Shared test fixtures for backend tests."""

import pytest

from server.datasets import load_sample_data
from server.engine import db_manager


@pytest.fixture(autouse=True, scope="session")
def _init_test_db():
    """Initialize DuckDB with sample data once for the entire test session."""
    db_manager.initialize()
    load_sample_data(db_manager)
    yield
    db_manager.shutdown()
