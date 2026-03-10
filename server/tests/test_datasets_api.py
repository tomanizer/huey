"""Tests for dataset discovery endpoints."""

from fastapi.testclient import TestClient


def test_list_datasets_returns_links_and_cursor(client: TestClient) -> None:
    r = client.get("/api/v1/datasets")
    assert r.status_code == 200
    body = r.json()
    assert body["total_count"] >= 2
    assert isinstance(body["items"], list)
    item = next(item for item in body["items"] if item["id"] == "trades_v1")
    assert item["links"]["self"] == "/api/v1/datasets/trades_v1"
    assert item["links"]["schema"] == "/api/v1/datasets/trades_v1/schema"
    assert item["links"]["picklist"] == "/api/v1/datasets/trades_v1/query/picklist"


def test_list_datasets_cursor_paginates(client: TestClient) -> None:
    first = client.get("/api/v1/datasets", params={"limit": 1})
    assert first.status_code == 200
    first_body = first.json()
    assert len(first_body["items"]) == 1
    assert first_body["cursor"] is not None

    second = client.get("/api/v1/datasets", params={"limit": 1, "cursor": first_body["cursor"]})
    assert second.status_code == 200
    second_body = second.json()
    assert len(second_body["items"]) == 1
    assert second_body["items"][0]["id"] != first_body["items"][0]["id"]


def test_get_dataset_returns_full_metadata(client: TestClient) -> None:
    r = client.get("/api/v1/datasets/trades_v1")
    assert r.status_code == 200
    assert r.headers["ETag"]
    assert r.headers["Cache-Control"] == "private, max-age=60"
    body = r.json()
    assert body["id"] == "trades_v1"
    assert body["source_kind"] == "sample_table"
    assert body["version"].startswith("v1-")
    assert body["row_count"] == 8
    assert body["time_dimension"]["field"] == "date"
    assert body["time_dimension"]["min"] == "2026-03-01"
    assert body["time_dimension"]["max"] == "2026-03-02"
    symbol = next(field for field in body["fields"] if field["name"] == "symbol")
    assert symbol["role"] == "dimension"
    assert symbol["distinct_count"] == 5
    volume = next(field for field in body["fields"] if field["name"] == "volume")
    assert volume["role"] == "measure"


def test_get_dataset_uses_conditional_get(client: TestClient) -> None:
    first = client.get("/api/v1/datasets/trades_v1")
    assert first.status_code == 200
    etag = first.headers["ETag"]
    second = client.get("/api/v1/datasets/trades_v1", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.headers["ETag"] == etag


def test_get_dataset_schema_uses_conditional_get(client: TestClient) -> None:
    first = client.get("/api/v1/datasets/trades_v1/schema")
    assert first.status_code == 200
    etag = first.headers["ETag"]
    second = client.get("/api/v1/datasets/trades_v1/schema", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.headers["ETag"] == etag


def test_get_dataset_not_found(client: TestClient) -> None:
    r = client.get("/api/v1/datasets/no_such")
    assert r.status_code == 404
    assert r.json()["code"] == "DATASET_NOT_FOUND"


def test_get_dataset_schema_not_found(client: TestClient) -> None:
    r = client.get("/api/v1/datasets/no_such/schema")
    assert r.status_code == 404
    assert r.json()["code"] == "DATASET_NOT_FOUND"


def test_dataset_routes_support_slashes_in_dataset_id(client: TestClient) -> None:
    dataset_id = "v1.0/btc/blocks"
    encoded = "v1.0%2Fbtc%2Fblocks"
    details = client.get(f"/api/v1/datasets/{encoded}")
    assert details.status_code == 200
    body = details.json()
    assert body["id"] == dataset_id
    assert body["links"]["self"] == f"/api/v1/datasets/{encoded}"

    schema = client.get(f"/api/v1/datasets/{encoded}/schema")
    assert schema.status_code == 200
    assert schema.json()["dataset_id"] == dataset_id
