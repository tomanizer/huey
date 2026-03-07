"""Tests for POST /query/picklist API — functional / happy-path tests."""

from fastapi.testclient import TestClient

from server.engine import db_manager


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
    r = client.post("/query/picklist", json=body)
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
    r = client.post("/query/picklist", json=body)
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
    r = client.post("/query/picklist", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["paging"]["limit"] == 1
    assert data["paging"]["returned"] <= 1
    assert data["total_count"] >= data["paging"]["returned"]


def test_query_picklist_cursor_paging(client: TestClient) -> None:
    first_page = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "paging": {"limit": 2}},
    }
    first_response = client.post("/query/picklist", json=first_page)
    assert first_response.status_code == 200
    first_data = first_response.json()
    assert first_data["paging"]["next_cursor"] is not None

    second_page = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"field": "symbol", "paging": {"limit": 2, "cursor": first_data["paging"]["next_cursor"]}},
    }
    second_response = client.post("/query/picklist", json=second_page)
    assert second_response.status_code == 200
    second_data = second_response.json()
    assert second_data["total_count"] == first_data["total_count"]
    assert second_data["paging"]["offset"] == 0
    first_values = [item["value"] for item in first_data["values"]]
    second_values = [item["value"] for item in second_data["values"]]
    assert first_values[-1] < second_values[0]
    assert set(first_values).isdisjoint(second_values)


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


def test_picklist_executes_sql_exactly_once(monkeypatch, client: TestClient) -> None:
    """Regression guard: /query/picklist must call execute_sql_async exactly once per request."""
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
    r = client.post("/query/picklist", json=body)
    assert r.status_code == 200
    assert call_count["n"] == 1, f"Expected exactly 1 SQL execution for /query/picklist, got {call_count['n']}"
