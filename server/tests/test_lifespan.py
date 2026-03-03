"""
Tests for lifespan startup and shutdown failure paths (#200).

Verifies:
- Critical startup failures (db_manager, ExportJobStore) propagate and abort startup.
- Non-critical failures (recover_stale_jobs) are caught, logged, and startup continues.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from server.main import app


class TestCriticalStartupFailures:
    """Critical init failures abort startup and propagate the exception."""

    def test_db_initialize_failure_aborts_startup(self) -> None:
        """db_manager.initialize() failure propagates out of the lifespan."""
        with (
            patch("server.main.db_manager") as mock_db,
            patch("server.main.load_sample_data"),
        ):
            mock_db.initialize.side_effect = RuntimeError("DuckDB init failed")
            mock_db.shutdown = MagicMock()
            with pytest.raises(RuntimeError, match="DuckDB init failed"):
                with TestClient(app):
                    pass  # pragma: no cover

    def test_export_store_initialize_failure_aborts_startup(self) -> None:
        """ExportJobStore.initialize() failure propagates out of the lifespan."""
        with (
            patch("server.main.db_manager") as mock_db,
            patch("server.main.load_sample_data"),
            patch("server.main.ExportJobStore") as mock_store_cls,
        ):
            mock_db.initialize = MagicMock()
            mock_db.shutdown = MagicMock()
            mock_store = MagicMock()
            mock_store_cls.return_value = mock_store
            mock_store.initialize.side_effect = OSError("Cannot open export DB")
            with pytest.raises(OSError, match="Cannot open export DB"):
                with TestClient(app):
                    pass  # pragma: no cover


class TestGracefulStartupDegradation:
    """Non-critical startup failures are caught and startup continues."""

    def test_recover_stale_jobs_failure_does_not_abort_startup(self) -> None:
        """recover_stale_jobs() failure is swallowed; the app starts and is healthy."""
        with (
            patch("server.main.db_manager") as mock_db,
            patch("server.main.load_sample_data"),
            patch("server.main.ExportJobStore") as mock_store_cls,
            patch("server.main.init_export_service") as mock_init_svc,
        ):
            mock_db.initialize = MagicMock()
            mock_db.shutdown = MagicMock()
            mock_store = MagicMock()
            mock_store_cls.return_value = mock_store
            mock_svc = MagicMock()
            mock_init_svc.return_value = mock_svc
            mock_svc.recover_stale_jobs.side_effect = RuntimeError("stale recovery failed")

            with TestClient(app) as client:
                response = client.get("/health/liveness")

        assert response.status_code == 200
