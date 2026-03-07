"""Tests for POST /query/tuples API — functional / happy-path tests."""

from fastapi.testclient import TestClient

from server.engine import db_manager


def test_query_tuples_returns_results(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 0}},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["total_count"] > 0
    assert len(data["items"]) > 0
    assert data["paging"]["returned"] == len(data["items"])
    symbols = [item["values"][0] for item in data["items"]]
    assert "AAPL" in symbols


def test_query_tuples_with_include_filter(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
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


def test_query_tuples_with_exclude_filter(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "fields": [{"field": "symbol"}],
            "filters": [{"field": "symbol", "operator": "EXCLUDE", "values": ["AAPL"]}],
            "paging": {"limit": 10, "offset": 0},
        },
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    data = r.json()
    symbols = {item["values"][0] for item in data["items"]}
    assert "AAPL" not in symbols
    assert data["total_count"] == 4


def test_query_tuples_date_range(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "range", "start": "2026-03-01", "end": "2026-03-02"},
        "query": {"fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 0}},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["total_count"] == 5


def test_query_tuples_paging(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol"}], "paging": {"limit": 2, "offset": 0}},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["paging"]["returned"] == 2
    assert data["total_count"] == 5


def test_query_tuples_paging_limit_one(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol", "sort": "ASC"}], "paging": {"limit": 1, "offset": 0}},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["paging"]["limit"] == 1
    assert data["paging"]["returned"] <= 1
    assert data["total_count"] >= data["paging"]["returned"]


def test_query_tuples_paging_offset(client: TestClient) -> None:
    body_page1 = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol", "sort": "ASC"}], "paging": {"limit": 2, "offset": 0}},
    }
    body_page2 = {**body_page1, "query": {**body_page1["query"], "paging": {"limit": 2, "offset": 2}}}
    r1 = client.post("/query/tuples", json=body_page1)
    r2 = client.post("/query/tuples", json=body_page2)
    page1_symbols = {item["values"][0] for item in r1.json()["items"]}
    page2_symbols = {item["values"][0] for item in r2.json()["items"]}
    assert page1_symbols.isdisjoint(page2_symbols)


def test_query_tuples_paging_offset_limit_one(client: TestClient) -> None:
    base_query = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol", "sort": "ASC"}]},
    }
    body_page1 = {**base_query, "query": {**base_query["query"], "paging": {"limit": 1, "offset": 0}}}
    body_page2 = {**base_query, "query": {**base_query["query"], "paging": {"limit": 1, "offset": 1}}}
    r1 = client.post("/query/tuples", json=body_page1)
    r2 = client.post("/query/tuples", json=body_page2)
    assert r1.status_code == 200
    assert r2.status_code == 200
    data1 = r1.json()
    data2 = r2.json()
    assert data1["paging"]["returned"] <= 1
    assert data2["paging"]["returned"] <= 1
    if data1["total_count"] > 1:
        assert data1["items"] != data2["items"]


def test_query_tuples_cursor_paging(client: TestClient) -> None:
    first_page = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol", "sort": "ASC"}], "paging": {"limit": 2, "offset": 0}},
    }
    first_response = client.post("/query/tuples", json=first_page)
    assert first_response.status_code == 200
    first_data = first_response.json()
    assert first_data["paging"]["next_cursor"] is not None

    second_page = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "fields": [{"field": "symbol", "sort": "ASC"}],
            "paging": {"limit": 2, "cursor": first_data["paging"]["next_cursor"]},
        },
    }
    second_response = client.post("/query/tuples", json=second_page)
    assert second_response.status_code == 200
    second_data = second_response.json()
    assert second_data["total_count"] == first_data["total_count"]
    assert second_data["paging"]["offset"] == 0
    first_symbols = [item["values"][0] for item in first_data["items"]]
    second_symbols = [item["values"][0] for item in second_data["items"]]
    assert first_symbols[-1] < second_symbols[0]
    assert set(first_symbols).isdisjoint(second_symbols)


def test_query_tuples_empty_page_reports_total(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 10}},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["items"] == []
    assert data["paging"]["returned"] == 0
    assert data["total_count"] == 5


def test_query_tuples_invalid_cursor_returns_422(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "fields": [{"field": "symbol", "sort": "ASC"}],
            "paging": {"limit": 2, "cursor": "not-a-valid-cursor"},
        },
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 422
    data = r.json()
    assert data["code"] == "VALIDATION_ERROR"
    assert data["details"]["errors"][0]["loc"] == ["body", "query", "paging", "cursor"]


def test_query_tuples_sort_desc(client: TestClient) -> None:
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol", "sort": "DESC"}], "paging": {"limit": 10, "offset": 0}},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    symbols = [item["values"][0] for item in r.json()["items"]]
    assert symbols == sorted(symbols, reverse=True)


def test_query_tuples_dataset_not_found(client: TestClient) -> None:
    body = {
        "dataset_id": "nonexistent",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 404



def test_tuples_executes_sql_exactly_once(monkeypatch, client: TestClient) -> None:
    """Regression guard: /query/tuples must call execute_sql_async exactly once per request."""
    call_count = {"n": 0}
    original = db_manager.execute_sql_async

    async def counted(*args, **kwargs):
        call_count["n"] += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(db_manager, "execute_sql_async", counted)
    body = {
        "dataset_id": "trades_v1",
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {"fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 0}},
    }
    r = client.post("/query/tuples", json=body)
    assert r.status_code == 200
    assert call_count["n"] == 1, f"Expected exactly 1 SQL execution for /query/tuples, got {call_count['n']}"
