"""Tests for POST /query/tuples API."""

from fastapi.testclient import TestClient


def test_query_tuples_ok(client: TestClient) -> None:
    """POST /query/tuples with valid envelope returns real tuple results."""
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"axis": "rows", "fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 0}},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["total_count"] > 0
    assert len(data["items"]) > 0
    assert data["paging"]["returned"] == len(data["items"])
    symbols = [item["values"][0] for item in data["items"]]
    assert "AAPL" in symbols


def test_query_tuples_with_filter(client: TestClient) -> None:
    """POST /query/tuples with INCLUDE filter returns filtered results."""
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "axis": "rows",
            "fields": [{"field": "symbol"}],
            "filters": [{"field": "symbol", "operator": "INCLUDE", "values": ["AAPL", "GOOG"]}],
            "paging": {"limit": 10, "offset": 0},
        },
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["total_count"] == 2
    symbols = {item["values"][0] for item in data["items"]}
    assert symbols == {"AAPL", "GOOG"}


def test_query_tuples_date_range(client: TestClient) -> None:
    """POST /query/tuples with date range returns tuples across dates."""
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "range", "start": "2026-03-01", "end": "2026-03-02"},
        "query": {"axis": "rows", "fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 0}},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["total_count"] == 5


def test_query_tuples_paging(client: TestClient) -> None:
    """POST /query/tuples with paging limits results."""
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"axis": "rows", "fields": [{"field": "symbol"}], "paging": {"limit": 2, "offset": 0}},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["paging"]["returned"] == 2
    assert data["total_count"] == 5


def test_query_tuples_dataset_not_found(client: TestClient) -> None:
    """POST /query/tuples with unknown dataset_id returns 404."""
    body = {
        "dataset_id": "nonexistent",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 404


def test_query_tuples_bad_date_range(client: TestClient) -> None:
    """POST /query/tuples with missing date_range type returns 422."""
    body = {
        "dataset_id": "trades_v1",
        "date_range": {},
        "query": {},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 422


def test_query_tuples_bad_date_format(client: TestClient) -> None:
    """POST /query/tuples with malformed date returns 422."""
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "not-a-date"},
        "query": {},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 422


def test_query_tuples_range_inverted(client: TestClient) -> None:
    """POST /query/tuples with start > end returns 422."""
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "range", "start": "2026-12-01", "end": "2026-01-01"},
        "query": {},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 422
