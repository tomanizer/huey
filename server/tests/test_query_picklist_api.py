"""Tests for POST /api/v1/datasets/{dataset_id}/query/members."""

from fastapi.testclient import TestClient

from server.engine import db_manager


def test_query_members_returns_items(client: TestClient) -> None:
    dataset_id = "trades_v1"
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "field": "symbol",
        "paging": {"limit": 100, "offset": 0},
    }
    r = client.post(f"/api/v1/datasets/{dataset_id}/query/members", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["field"] == "symbol"
    assert data["total_count"] > 0
    assert len(data["items"]) > 0
    assert "meta" in data
    values = [v["value"] for v in data["items"]]
    assert "AAPL" in values
    for v in data["items"]:
        assert "value" in v
        assert "count" in v


def test_query_members_search_wildcard(client: TestClient) -> None:
    dataset_id = "trades_v1"
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "field": "symbol",
        "search": "A*",
        "paging": {"limit": 100, "offset": 0},
    }
    r = client.post(f"/api/v1/datasets/{dataset_id}/query/members", json=body)
    assert r.status_code == 200
    data = r.json()
    values = [v["value"] for v in data["items"]]
    assert all(v.startswith("A") for v in values)
    assert "AAPL" in values
    assert "AMZN" in values


def test_query_members_string_derivation_default_alias(client: TestClient) -> None:
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "field": "symbol",
        "derivation": "uppercase",
        "paging": {"limit": 100, "offset": 0},
    }
    r = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["field"] == "symbol__uppercase"
    assert "AAPL" in [item["value"] for item in data["items"]]


def test_query_members_derivation_alias_override(client: TestClient) -> None:
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "field": "symbol",
        "derivation": "uppercase",
        "alias": "symbol_upper",
        "paging": {"limit": 100, "offset": 0},
    }
    r = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    assert r.status_code == 200
    assert r.json()["field"] == "symbol_upper"


def test_query_members_with_filter(client: TestClient) -> None:
    dataset_id = "trades_v1"
    body = {
        "date_range": {"type": "range", "start": "2026-03-01", "end": "2026-03-02"},
        "field": "symbol",
        "filters": [{"field": "symbol", "operator": "EXCLUDE", "values": ["AAPL"]}],
        "paging": {"limit": 100, "offset": 0},
    }
    r = client.post(f"/api/v1/datasets/{dataset_id}/query/members", json=body)
    assert r.status_code == 200
    values = [v["value"] for v in r.json()["items"]]
    assert "AAPL" not in values


def test_query_members_with_search_and_between_filter(client: TestClient) -> None:
    dataset_id = "trades_v1"
    body = {
        "date_range": {"type": "range", "start": "2026-03-01", "end": "2026-03-02"},
        "field": "symbol",
        "search": "AA*",
        "filters": [{"field": "volume", "operator": "BETWEEN", "values": [1000, 3000]}],
        "paging": {"limit": 10, "offset": 0},
    }
    r = client.post(f"/api/v1/datasets/{dataset_id}/query/members", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["total_count"] == 1
    assert data["paging"]["returned"] == 1
    assert [v["value"] for v in data["items"]] == ["AAPL"]


def test_query_members_returns_counts_in_current_filter_context(client: TestClient) -> None:
    body = {
        "date_range": {"type": "range", "start": "2026-03-01", "end": "2026-03-02"},
        "field": "symbol",
        "filters": [{"field": "volume", "operator": "BETWEEN", "values": [1500, 2200]}],
        "paging": {"limit": 10, "offset": 0},
    }
    r = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    assert r.status_code == 200
    items = {item["value"]: item["count"] for item in r.json()["items"]}
    assert items == {"AAPL": 2, "GOOG": 2, "MSFT": 2}


def test_query_members_paging(client: TestClient) -> None:
    dataset_id = "trades_v1"
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "field": "symbol",
        "paging": {"limit": 2, "offset": 0},
    }
    r = client.post(f"/api/v1/datasets/{dataset_id}/query/members", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["paging"]["returned"] == 2
    assert data["total_count"] == 5


def test_query_members_paging_limit_one(client: TestClient) -> None:
    dataset_id = "trades_v1"
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "field": "symbol",
        "paging": {"limit": 1, "offset": 0},
    }
    r = client.post(f"/api/v1/datasets/{dataset_id}/query/members", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["paging"]["limit"] == 1
    assert data["paging"]["returned"] <= 1
    assert data["total_count"] >= data["paging"]["returned"]


def test_query_members_empty_page_reports_total(client: TestClient) -> None:
    dataset_id = "trades_v1"
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "field": "symbol",
        "paging": {"limit": 5, "offset": 10},
    }
    r = client.post(f"/api/v1/datasets/{dataset_id}/query/members", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["items"] == []
    assert data["paging"]["returned"] == 0
    assert data["total_count"] == 5


def test_query_members_dataset_not_found(client: TestClient) -> None:
    body = {"date_range": {"type": "single", "date": "2026-03-01"}, "field": "symbol"}
    r = client.post("/api/v1/datasets/nonexistent/query/members", json=body)
    assert r.status_code == 404


def test_members_executes_sql_exactly_once(monkeypatch, client: TestClient) -> None:
    """Regression guard: the v1 members endpoint must call execute_sql_async exactly once per request."""
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "field": "symbol",
        "paging": {"limit": 10, "offset": 0},
    }
    r = client.post("/api/v1/datasets/trades_v1/query/members", json=body)
    assert r.status_code == 200
    assert call_count["n"] == 1, (
        "Expected exactly 1 SQL execution for /api/v1/datasets/{dataset_id}/query/members, "
        f"got {call_count['n']}"
    )
