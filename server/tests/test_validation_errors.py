"""Tests for request validation (422 errors) across all endpoints."""

from fastapi.testclient import TestClient


class TestTuplesValidation:
    def test_missing_dataset_id(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "date_range": {"type": "single", "date": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_empty_body(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={})
        assert r.status_code == 422

    def test_not_json(self, client: TestClient) -> None:
        r = client.post("/query/tuples", content="not json", headers={"Content-Type": "application/json"})
        assert r.status_code == 422

    def test_dataset_id_wrong_type(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "dataset_id": 123,
            "date_range": {"type": "single", "date": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_date_range_unknown_type(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "weekly", "date": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_date_range_null(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "dataset_id": "trades_v1",
            "date_range": None,
            "query": {},
        })
        assert r.status_code == 422

    def test_date_range_missing_date_field(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single"},
            "query": {},
        })
        assert r.status_code == 422

    def test_range_missing_end(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "range", "start": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_filter_missing_operator(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "fields": [{"field": "symbol"}],
                "filters": [{"field": "symbol", "values": ["AAPL"]}],
            },
        })
        assert r.status_code == 422

    def test_filter_missing_values(self, client: TestClient) -> None:
        r = client.post("/query/tuples", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026-03-01"},
            "query": {
                "fields": [{"field": "symbol"}],
                "filters": [{"field": "symbol", "operator": "INCLUDE"}],
            },
        })
        assert r.status_code == 422


class TestCellsValidation:
    def test_missing_dataset_id(self, client: TestClient) -> None:
        r = client.post("/query/cells", json={
            "date_range": {"type": "single", "date": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_dataset_id_wrong_type(self, client: TestClient) -> None:
        r = client.post("/query/cells", json={
            "dataset_id": 123,
            "date_range": {"type": "single", "date": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_empty_body(self, client: TestClient) -> None:
        r = client.post("/query/cells", json={})
        assert r.status_code == 422


class TestPicklistValidation:
    def test_missing_dataset_id(self, client: TestClient) -> None:
        r = client.post("/query/picklist", json={
            "date_range": {"type": "single", "date": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_empty_body(self, client: TestClient) -> None:
        r = client.post("/query/picklist", json={})
        assert r.status_code == 422

    def test_bad_date_format(self, client: TestClient) -> None:
        r = client.post("/query/picklist", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "single", "date": "2026/03/01"},
            "query": {},
        })
        assert r.status_code == 422


class TestExportValidation:
    def test_missing_dataset_id(self, client: TestClient) -> None:
        r = client.post("/export", json={
            "date_range": {"type": "single", "date": "2026-01-01"},
            "query": {},
        })
        assert r.status_code == 422

    def test_empty_body(self, client: TestClient) -> None:
        r = client.post("/export", json={})
        assert r.status_code == 422

    def test_date_range_unknown_type(self, client: TestClient) -> None:
        r = client.post("/export", json={
            "dataset_id": "trades_v1",
            "date_range": {"type": "invalid"},
            "query": {},
        })
        assert r.status_code == 422


class TestSchemaValidation:
    def test_missing_dataset_id_param(self, client: TestClient) -> None:
        r = client.get("/schema")
        assert r.status_code == 422
