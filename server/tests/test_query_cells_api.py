"""Tests for POST /api/v1/datasets/{dataset_id}/query/cells."""

import pytest
from fastapi.testclient import TestClient

from server.config import get_settings
from server.engine import db_manager


def test_query_cells_returns_aggregated_data(client: TestClient) -> None:
    dataset_id = "trades_v1"
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
        },
    }
    r = client.post(f"/api/v1/datasets/{dataset_id}/query/cells", json=body)
    assert r.status_code == 200
    data = r.json()
    assert len(data["cells"]) > 0
    cell = data["cells"][0]
    assert "row_index" in cell
    assert "values" in cell
    assert isinstance(cell["values"], dict)


def test_query_cells_multiple_aggregations(client: TestClient) -> None:
    dataset_id = "trades_v1"
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [],
            "measures": [
                {"field": "volume", "aggregation": "SUM", "alias": "sum_vol"},
                {"field": "volume", "aggregation": "AVG", "alias": "avg_vol"},
                {"field": "volume", "aggregation": "MIN", "alias": "min_vol"},
                {"field": "volume", "aggregation": "MAX", "alias": "max_vol"},
                {"field": "volume", "aggregation": "COUNT", "alias": "cnt_vol"},
            ],
        },
    }
    r = client.post(f"/api/v1/datasets/{dataset_id}/query/cells", json=body)
    assert r.status_code == 200
    cells = r.json()["cells"]
    assert len(cells) > 0
    # Each cell should have symbol + 5 aggregation values = 6 values
    assert len(cells[0]["values"]) == 6


def test_query_cells_with_filter(client: TestClient) -> None:
    dataset_id = "trades_v1"
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
        },
        "filters": [{"field": "symbol", "operator": "INCLUDE", "values": ["AAPL"]}],
    }
    r = client.post(f"/api/v1/datasets/{dataset_id}/query/cells", json=body)
    assert r.status_code == 200
    cells = r.json()["cells"]
    assert len(cells) == 1
    assert cells[0]["values"]["0"] == "AAPL"


def test_query_cells_empty_axes_returns_empty(client: TestClient) -> None:
    body = {"date_range": {"type": "single", "date": "2026-03-01"}, "axes": {"rows": [], "columns": [], "measures": []}}
    r = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    assert r.status_code == 200
    assert r.json()["cells"] == []


def test_query_cells_dataset_not_found(client: TestClient) -> None:
    body = {"date_range": {"type": "single", "date": "2026-03-01"}, "axes": {"rows": [], "columns": [], "measures": []}}
    r = client.post("/api/v1/datasets/nonexistent/query/cells", json=body)
    assert r.status_code == 404


def test_query_cells_row_window_limits_results(client: TestClient) -> None:
    dataset_id = "trades_v1"
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "window": {"rows": {"offset": 0, "limit": 1}},
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
        },
    }
    r = client.post(f"/api/v1/datasets/{dataset_id}/query/cells", json=body)
    assert r.status_code == 200
    cells = r.json()["cells"]
    assert len(cells) == 1
    # Ordered ascending, first symbol should be AAPL from sample data
    assert cells[0]["values"]["0"] == "AAPL"


def test_query_cells_window_too_large_returns_error(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "max_cells_per_response", 1, raising=False)
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "window": {
            "rows": {"offset": 0, "limit": 2},
            "columns": {"offset": 0, "limit": 2},
        },
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [{"field": "date"}],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
        },
    }
    r = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    assert r.status_code == 400
    data = r.json()
    assert data["code"] == "CELLS_WINDOW_TOO_LARGE"


def test_query_cells_no_windows_cap_enforced(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """No windows + grouped result exceeding cap -> 400 CELLS_WINDOW_TOO_LARGE."""
    settings = get_settings()
    monkeypatch.setattr(settings, "max_cells_per_response", 1, raising=False)
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
        },
    }
    r = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    assert r.status_code == 400
    data = r.json()
    assert data["code"] == "CELLS_WINDOW_TOO_LARGE"
    assert "max_cells_per_response" in data["details"]
    assert data["details"]["max_cells_per_response"] == 1


def test_query_cells_row_window_only_cap_enforced(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Row window only (no column window), unbounded column axis exceeds cap -> 400.

    rows.count=1 is within the cap (1), but the unbounded date column axis produces
    2 distinct dates across the range, so 1 row × 2 dates = 2 cells > cap=1. The
    post-execution hard cap must fire, not the pre-flight check.
    """
    settings = get_settings()
    monkeypatch.setattr(settings, "max_cells_per_response", 1, raising=False)
    body = {
        "date_range": {"type": "range", "start": "2026-03-01", "end": "2026-03-02"},
        "window": {"rows": {"offset": 0, "limit": 1}},
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [{"field": "date"}],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
        },
    }
    r = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    assert r.status_code == 400
    assert r.json()["code"] == "CELLS_WINDOW_TOO_LARGE"


def test_query_cells_col_window_only_cap_enforced(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Column window only (no row window), unbounded row axis exceeds cap -> 400.

    columns.count=1 is within the cap (1), but the unbounded symbol row axis has
    5 distinct values for the single date, so 5 rows × 1 date = 5 cells > cap=1.
    The post-execution hard cap must fire, not the pre-flight check.
    """
    settings = get_settings()
    monkeypatch.setattr(settings, "max_cells_per_response", 1, raising=False)
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "window": {"columns": {"offset": 0, "limit": 1}},
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [{"field": "date"}],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
        },
    }
    r = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    assert r.status_code == 400
    assert r.json()["code"] == "CELLS_WINDOW_TOO_LARGE"


def test_query_cells_within_cap_succeeds(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Small result within cap succeeds even when windows are omitted."""
    settings = get_settings()
    monkeypatch.setattr(settings, "max_cells_per_response", 10000, raising=False)
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
        },
    }
    r = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    assert r.status_code == 200
    assert len(r.json()["cells"]) > 0


def test_cells_executes_sql_exactly_once(monkeypatch, client: TestClient) -> None:
    """Regression guard: the v1 cells endpoint must call execute_sql_async exactly once per request."""
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
        },
    }
    r = client.post("/api/v1/datasets/trades_v1/query/cells", json=body)
    assert r.status_code == 200
    assert call_count["n"] == 1, (
        "Expected exactly 1 SQL execution for /api/v1/datasets/{dataset_id}/query/cells, "
        f"got {call_count['n']}"
    )
