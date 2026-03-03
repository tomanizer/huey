"""Tests for POST /query/cells API — functional / happy-path tests."""

import pytest
from fastapi.testclient import TestClient
from server.config import get_settings


def test_query_cells_returns_aggregated_data(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "axes": {
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
            },
        },
    }
    r = client.post("/query/cells", json=body)
    assert r.status_code == 200
    data = r.json()
    assert len(data["cells"]) > 0
    cell = data["cells"][0]
    assert "row_index" in cell
    assert "values" in cell
    assert isinstance(cell["values"], dict)


def test_query_cells_multiple_aggregations(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
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
        },
    }
    r = client.post("/query/cells", json=body)
    assert r.status_code == 200
    cells = r.json()["cells"]
    assert len(cells) > 0
    # Each cell should have symbol + 5 aggregation values = 6 values
    assert len(cells[0]["values"]) == 6


def test_query_cells_with_filter(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "axes": {
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
            },
            "filters": [{"field": "symbol", "operator": "INCLUDE", "values": ["AAPL"]}],
        },
    }
    r = client.post("/query/cells", json=body)
    assert r.status_code == 200
    cells = r.json()["cells"]
    assert len(cells) == 1
    assert cells[0]["values"]["0"] == "AAPL"


def test_query_cells_empty_axes_returns_empty(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"axes": {"rows": [], "columns": [], "measures": []}},
    }
    r = client.post("/query/cells", json=body)
    assert r.status_code == 200
    assert r.json()["cells"] == []


def test_query_cells_dataset_not_found(client: TestClient) -> None:
    body = {"dataset_id": "nonexistent", "date_range": {"type": "single", "date": "2026-03-01"}, "query": {}}
    r = client.post("/query/cells", json=body)
    assert r.status_code == 404


def test_query_cells_row_window_limits_results(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "rows": {"start_index": 0, "count": 1},
            "axes": {
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
            },
        },
    }
    r = client.post("/query/cells", json=body)
    assert r.status_code == 200
    cells = r.json()["cells"]
    assert len(cells) == 1
    # Ordered ascending, first symbol should be AAPL from sample data
    assert cells[0]["values"]["0"] == "AAPL"


def test_query_cells_window_too_large_returns_error(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "max_cells_per_response", 1, raising=False)
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "rows": {"start_index": 0, "count": 2},
            "columns": {"start_index": 0, "count": 2},
            "axes": {
                "rows": [{"field": "symbol"}],
                "columns": [{"field": "date"}],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}],
            },
        },
    }
    r = client.post("/query/cells", json=body)
    assert r.status_code == 400
    data = r.json()
    assert data["code"] == "CELLS_WINDOW_TOO_LARGE"
