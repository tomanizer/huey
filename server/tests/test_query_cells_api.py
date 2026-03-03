"""Tests for POST /query/cells API — functional / happy-path tests."""

from fastapi.testclient import TestClient


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
