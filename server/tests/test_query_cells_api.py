"""Tests for POST /query/cells API."""

from fastapi.testclient import TestClient


def test_query_cells_ok(client: TestClient) -> None:
    """POST /query/cells with valid envelope returns aggregated cells."""
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "axes": {
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "volume", "aggregation": "sum", "alias": "sum_volume"}],
            },
            "filters": [],
        },
    }
    r = client.post("/query/cells", json=body)
    assert r.status_code == 200
    data = r.json()
    assert len(data["cells"]) > 0


def test_query_cells_empty_axes(client: TestClient) -> None:
    """POST /query/cells with no axes returns empty cells."""
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "axes": {"rows": [], "columns": [], "measures": []},
            "filters": [],
        },
    }
    r = client.post("/query/cells", json=body)
    assert r.status_code == 200
    assert r.json()["cells"] == []


def test_query_cells_dataset_not_found(client: TestClient) -> None:
    """POST /query/cells with unknown dataset_id returns 404."""
    body = {"dataset_id": "nonexistent", "date_range": {"type": "single", "date": "2026-03-01"}, "query": {}}
    r = client.post("/query/cells", json=body)
    assert r.status_code == 404


def test_query_cells_bad_date_range(client: TestClient) -> None:
    """POST /query/cells with missing date_range type returns 422."""
    body = {"dataset_id": "trades_v1", "date_range": {}, "query": {}}
    r = client.post("/query/cells", json=body)
    assert r.status_code == 422
