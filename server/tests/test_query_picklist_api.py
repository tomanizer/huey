"""Tests for POST /api/v1/datasets/{dataset_id}/query/picklist."""

from fastapi.testclient import TestClient

from server.engine import db_manager


def test_query_picklist_returns_values(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "paging": {"limit": 100, "offset": 0}},
    }
    r = client.post(f"/api/v1/datasets/{body['dataset_id']}/query/picklist", json=body)
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
    r = client.post(f"/api/v1/datasets/{body['dataset_id']}/query/picklist", json=body)
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
    r = client.post(f"/api/v1/datasets/{body['dataset_id']}/query/picklist", json=body)
    assert r.status_code == 200
    values = [v["value"] for v in r.json()["values"]]
    assert "AAPL" not in values


def test_query_picklist_with_search_and_between_filter(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "range", "start": "2026-03-01", "end": "2026-03-02"},
        "query": {
            "field": "symbol",
            "search": "AA*",
            "filters": [{"field": "volume", "operator": "BETWEEN", "values": [1000, 3000]}],
            "paging": {"limit": 10, "offset": 0},
        },
    }
    r = client.post(f"/api/v1/datasets/{body['dataset_id']}/query/picklist", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["total_count"] == 1
    assert data["paging"]["returned"] == 1
    assert [v["value"] for v in data["values"]] == ["AAPL"]


def test_query_picklist_paging(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "paging": {"limit": 2, "offset": 0}},
    }
    r = client.post(f"/api/v1/datasets/{body['dataset_id']}/query/picklist", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["paging"]["returned"] == 2
    assert data["total_count"] == 5


def test_query_picklist_paging_limit_one(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "paging": {"limit": 1, "offset": 0}},
    }
    r = client.post(f"/api/v1/datasets/{body['dataset_id']}/query/picklist", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["paging"]["limit"] == 1
    assert data["paging"]["returned"] <= 1
    assert data["total_count"] >= data["paging"]["returned"]


def test_query_picklist_empty_page_reports_total(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "paging": {"limit": 5, "offset": 10}},
    }
    r = client.post(f"/api/v1/datasets/{body['dataset_id']}/query/picklist", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["values"] == []
    assert data["paging"]["returned"] == 0
    assert data["total_count"] == 5


def test_query_picklist_dataset_not_found(client: TestClient) -> None:
    body = {"dataset_id": "nonexistent", "date_range": {"type": "single", "date": "2026-03-01"}, "query": {}}
    r = client.post(f"/api/v1/datasets/{body['dataset_id']}/query/picklist", json=body)
    assert r.status_code == 404


def test_picklist_executes_sql_exactly_once(monkeypatch, client: TestClient) -> None:
    """Regression guard: the v1 picklist endpoint must call execute_sql_async exactly once per request."""
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "paging": {"limit": 10, "offset": 0}},
    }
    r = client.post(f"/api/v1/datasets/{body['dataset_id']}/query/picklist", json=body)
    assert r.status_code == 200
    assert call_count["n"] == 1, (
        "Expected exactly 1 SQL execution for /api/v1/datasets/{dataset_id}/query/picklist, "
        f"got {call_count['n']}"
    )
