"""
Backend integration tests: full API flow with real app and config.

Exercises schema -> query (tuples, cells, members) -> export in sequence
using the default dataset config (no S3 required).
"""

from fastapi.testclient import TestClient


def test_full_api_flow(client: TestClient) -> None:
    """Integration: GET schema -> POST tuples, cells, members -> POST export -> GET status."""
    dataset_id = "trades_v1"
    date_range = {"type": "single", "date": "2026-03-01"}

    r_schema = client.get(f"/api/v1/datasets/{dataset_id}/schema")
    assert r_schema.status_code == 200
    schema = r_schema.json()
    assert schema["dataset_id"] == dataset_id
    assert len(schema["fields"]) > 0

    r_tuples = client.post(f"/api/v1/datasets/{dataset_id}/query/tuples", json={
        "date_range": date_range,
        "fields": [{"field": "symbol"}],
        "paging": {"limit": 10, "offset": 0},
    })
    assert r_tuples.status_code == 200
    tuples_data = r_tuples.json()
    assert tuples_data["total_count"] > 0
    assert len(tuples_data["items"]) > 0

    r_cells = client.post(f"/api/v1/datasets/{dataset_id}/query/cells", json={
        "date_range": date_range,
        "axes": {
            "rows": [{"field": "symbol"}],
            "columns": [],
            "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_vol"}],
        },
    })
    assert r_cells.status_code == 200
    cells_data = r_cells.json()
    assert len(cells_data["cells"]) > 0
    assert "row" in cells_data["cells"][0]
    assert "col" in cells_data["cells"][0]

    r_picklist = client.post(f"/api/v1/datasets/{dataset_id}/query/members", json={
        "date_range": date_range,
        "field": "symbol",
        "paging": {"limit": 100, "offset": 0},
    })
    assert r_picklist.status_code == 200
    picklist_data = r_picklist.json()
    assert picklist_data["total_count"] > 0
    assert len(picklist_data["values"]) > 0

    r_export = client.post("/api/v1/exports", json={
        "dataset_id": dataset_id,
        "date_range": date_range,
        "query": {"export_type": "pivot_results", "axes": {}, "filters": [], "max_rows": 1000, "format": "csv"},
    })
    assert r_export.status_code == 200
    export_data = r_export.json()
    assert export_data["status"] == "pending"

    r_status = client.get(f"/api/v1/exports/{export_data['export_id']}")
    assert r_status.status_code == 200
    assert r_status.json()["status"] in ("pending", "processing", "complete")
