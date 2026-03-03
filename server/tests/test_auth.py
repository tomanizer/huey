from fastapi.testclient import TestClient


def test_auth_missing_key_returns_401(auth_client: TestClient):
    r = auth_client.get("/schema", params={"dataset_id": "trades_v1"})
    assert r.status_code == 401


def test_auth_invalid_key_returns_401(auth_client: TestClient):
    r = auth_client.get(
        "/schema",
        params={"dataset_id": "trades_v1"},
        headers={"X-API-Key": "wrong"},
    )
    assert r.status_code == 401


def test_auth_valid_key_returns_200(auth_client: TestClient):
    r = auth_client.get(
        "/schema",
        params={"dataset_id": "trades_v1"},
        headers={"X-API-Key": "test-key-123"},
    )
    assert r.status_code == 200


def test_health_no_auth_required(auth_client: TestClient):
    r = auth_client.get("/health/liveness")
    assert r.status_code == 200
