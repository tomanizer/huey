"""Tests for POST /query/picklist API — functional / happy-path tests."""

from fastapi.testclient import TestClient


def test_query_picklist_returns_values(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "paging": {"limit": 100, "offset": 0}},
    }
    r = client.post("/query/picklist", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["total_count"] > 0
    assert len(data["values"]) > 0
    values = [v["value"] for v in data["values"]]
    assert "AAPL" in values
    for v in data["values"]:
        assert "value" in v
        assert "label" in v


def test_query_picklist_search_wildcard(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "search": "A*", "paging": {"limit": 100, "offset": 0}},
    }
    r = client.post("/query/picklist", json=body)
    assert r.status_code == 200
    data = r.json()
    values = [v["value"] for v in data["values"]]
    assert all(v.startswith("A") for v in values)
    assert "AAPL" in values
    assert "AMZN" in values


def test_query_picklist_with_filter(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "range", "start": "2026-03-01", "end": "2026-03-02"},
        "query": {
            "field": "symbol",
            "filters": [{"field": "symbol", "operator": "EXCLUDE", "values": ["AAPL"]}],
            "paging": {"limit": 100, "offset": 0},
        },
    }
    r = client.post("/query/picklist", json=body)
    assert r.status_code == 200
    values = [v["value"] for v in r.json()["values"]]
    assert "AAPL" not in values


def test_query_picklist_paging(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "paging": {"limit": 2, "offset": 0}},
    }
    r = client.post("/query/picklist", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["paging"]["returned"] == 2
    assert data["total_count"] == 5


def test_query_picklist_empty_page_reports_total(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "paging": {"limit": 5, "offset": 10}},
    }
    r = client.post("/query/picklist", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["values"] == []
    assert data["paging"]["returned"] == 0
    assert data["total_count"] == 5


def test_query_picklist_dataset_not_found(client: TestClient) -> None:
    body = {"dataset_id": "nonexistent", "date_range": {"type": "single", "date": "2026-03-01"}, "query": {}}
    r = client.post("/query/picklist", json=body)
    assert r.status_code == 404
