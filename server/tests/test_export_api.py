"""Tests for the v1 export submission, status, list, file, and delete endpoints."""

import csv
import io
import json
import sqlite3
import time

import duckdb
import pytest
from fastapi.testclient import TestClient

from server.export_service import get_export_service


@pytest.fixture(autouse=True)
def _clear_exports():
    """Reset the export store between tests."""
    svc = get_export_service()
    store = svc.store
    with store._lock:
        store._conn.execute("DELETE FROM export_jobs")
        store._conn.commit()
    yield
    with store._lock:
        store._conn.execute("DELETE FROM export_jobs")
        store._conn.commit()


def _submit_path(dataset_id: str = "trades_v1") -> str:
    return f"/api/v1/datasets/{dataset_id}/exports"


def _file_path(export_id: str) -> str:
    return f"/api/v1/exports/{export_id}/file"


def _valid_body(**overrides):
    body = {
        "date_range": {"type": "single", "date": "2026-03-01"},
        "query": {
            "export_type": "pivot_results",
            "axes": {
                "rows": [{"field": "symbol"}],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "total_volume"}],
            },
            "filters": [],
            "max_rows": 1000,
            "format": "csv",
        },
    }
    body.update(overrides)
    return body


def _wait_for_complete(client: TestClient, export_id: str) -> dict:
    for _ in range(20):
        status_r = client.get(f"/api/v1/exports/{export_id}")
        assert status_r.status_code == 200
        if status_r.json()["status"] == "complete":
            return status_r.json()
        time.sleep(0.05)
    pytest.fail("Export did not complete in time")


def _run_export_and_download(client: TestClient, body: dict, dataset_id: str = "trades_v1") -> tuple[str, list[list[str]], dict]:
    """Submit an export, wait for completion, download, parse CSV rows."""
    r = client.post(_submit_path(dataset_id), json=body)
    assert r.status_code == 202
    export_id = r.json()["export_id"]

    status_payload = _wait_for_complete(client, export_id)
    dl = client.get(_file_path(export_id))
    assert dl.status_code == 200
    reader = csv.reader(io.StringIO(dl.text))
    return export_id, list(reader), status_payload


class TestExportLifecycle:
    def test_post_export_returns_accepted(self, client: TestClient) -> None:
        r = client.post(_submit_path(), json=_valid_body())
        assert r.status_code == 202
        data = r.json()
        assert data["export_id"].startswith("exp-")
        assert data["dataset_id"] == "trades_v1"
        assert data["status"] == "pending"
        assert data["links"]["self"] == f"/api/v1/exports/{data['export_id']}"
        assert data["links"]["file"] == _file_path(data["export_id"])

    def test_export_completes_with_real_data(self, client: TestClient) -> None:
        _, rows, _ = _run_export_and_download(client, _valid_body())
        header = rows[0]
        assert header == ["symbol", "total_volume"]
        data_rows = rows[1:]
        assert len(data_rows) > 0
        symbols = {r[0] for r in data_rows}
        assert symbols & {"AAPL", "GOOG", "MSFT", "AMZN", "TSLA"}

    def test_export_status_includes_dataset_links_and_metadata(self, client: TestClient) -> None:
        r = client.post(_submit_path(), json=_valid_body())
        assert r.status_code == 202
        export_id = r.json()["export_id"]

        status_payload = _wait_for_complete(client, export_id)
        assert status_payload["dataset_id"] == "trades_v1"
        assert status_payload["format"] == "csv"
        assert status_payload["size_bytes"] is not None
        assert status_payload["completed_at"].endswith("Z")
        assert status_payload["created_at"].endswith("Z")
        assert status_payload["expires_at"].endswith("Z")
        assert status_payload["download_url"] == _file_path(export_id)
        assert status_payload["links"] == {
            "self": f"/api/v1/exports/{export_id}",
            "file": _file_path(export_id),
        }

    def test_default_export_format_is_parquet(self, client: TestClient) -> None:
        body = _valid_body()
        del body["query"]["format"]

        r = client.post(_submit_path(), json=body)
        assert r.status_code == 202
        export_id = r.json()["export_id"]

        _wait_for_complete(client, export_id)
        dl = client.get(_file_path(export_id))
        assert dl.status_code == 200
        assert dl.headers["content-type"].startswith("application/octet-stream")
        assert "filename=\"exp-" in dl.headers.get("content-disposition", "")
        assert ".parquet" in dl.headers.get("content-disposition", "")
        assert len(dl.content) > 0

    def test_sqlite_export_download(self, client: TestClient, tmp_path) -> None:
        body = _valid_body()
        body["query"]["format"] = "sqlite"

        r = client.post(_submit_path(), json=body)
        assert r.status_code == 202
        export_id = r.json()["export_id"]

        _wait_for_complete(client, export_id)
        dl = client.get(_file_path(export_id))
        assert dl.status_code == 200
        assert dl.headers["content-type"].startswith("application/vnd.sqlite3")
        assert ".sqlite" in dl.headers.get("content-disposition", "")

        sqlite_file = tmp_path / f"{export_id}.sqlite"
        sqlite_file.write_bytes(dl.content)
        with sqlite3.connect(sqlite_file) as conn:
            row_count = conn.execute("SELECT COUNT(*) FROM export_result").fetchone()[0]
        assert row_count > 0

    def test_duckdb_export_download(self, client: TestClient, tmp_path) -> None:
        body = _valid_body()
        body["query"]["format"] = "duckdb"

        r = client.post(_submit_path(), json=body)
        assert r.status_code == 202
        export_id = r.json()["export_id"]

        _wait_for_complete(client, export_id)
        dl = client.get(_file_path(export_id))
        assert dl.status_code == 200
        assert dl.headers["content-type"].startswith("application/vnd.duckdb")
        assert ".duckdb" in dl.headers.get("content-disposition", "")

        duckdb_file = tmp_path / f"{export_id}.duckdb"
        duckdb_file.write_bytes(dl.content)
        with duckdb.connect(str(duckdb_file), read_only=True) as conn:
            row_count = conn.execute("SELECT COUNT(*) FROM export_result").fetchone()[0]
        assert row_count > 0


class TestExportListing:
    def test_list_exports_returns_newest_first_with_cursor(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-a", "trades_v1", "csv")
        time.sleep(0.01)
        store.create("exp-b", "trades_v1", "csv")
        time.sleep(0.01)
        store.create("exp-c", "trades_v1", "csv")

        first_page = client.get("/api/v1/exports", params={"limit": 2})
        assert first_page.status_code == 200
        first_payload = first_page.json()
        assert [item["export_id"] for item in first_payload["items"]] == ["exp-c", "exp-b"]
        assert first_payload["cursor"] is not None

        second_page = client.get("/api/v1/exports", params={"limit": 2, "cursor": first_payload["cursor"]})
        assert second_page.status_code == 200
        second_payload = second_page.json()
        assert [item["export_id"] for item in second_payload["items"]] == ["exp-a"]
        assert second_payload["cursor"] is None

    def test_list_exports_filters_by_status(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-processing", "trades_v1", "csv")
        store.update_status("exp-processing", "processing")
        store.create("exp-complete", "trades_v1", "csv")
        store.update_status("exp-complete", "processing")
        store.update_status("exp-complete", "complete", file_path="/tmp/f.csv")

        response = client.get("/api/v1/exports", params={"status": "processing"})
        assert response.status_code == 200
        assert [item["export_id"] for item in response.json()["items"]] == ["exp-processing"]


class TestExportDeletion:
    @pytest.mark.parametrize("state", ["pending", "processing"])
    def test_delete_cancels_active_exports(self, client: TestClient, state: str) -> None:
        store = get_export_service().store
        store.create("exp-active", "trades_v1", "csv")
        if state == "processing":
            store.update_status("exp-active", "processing")

        response = client.delete("/api/v1/exports/exp-active")
        assert response.status_code == 204
        assert response.content == b""
        assert store.get("exp-active").status == "cancelled"

    @pytest.mark.parametrize("state", ["complete", "failed", "expired", "cancelled"])
    def test_delete_removes_terminal_exports_and_files(self, client: TestClient, tmp_path, state: str) -> None:
        store = get_export_service().store
        export_file = tmp_path / f"exp-{state}.csv"
        export_file.write_text("a,b\n1,2\n")
        store.create(f"exp-{state}", "trades_v1", "csv")
        if state in {"complete", "failed", "expired", "cancelled"}:
            store.update_status(f"exp-{state}", "processing")
        if state == "complete":
            store.update_status(f"exp-{state}", "complete", file_path=str(export_file))
        elif state == "failed":
            store.update_status(f"exp-{state}", "failed", file_path=str(export_file), error_message="boom")
        elif state == "expired":
            store.update_status(f"exp-{state}", "expired", file_path=str(export_file))
        else:
            store.update_status(f"exp-{state}", "cancelled", file_path=str(export_file))

        response = client.delete(f"/api/v1/exports/exp-{state}")
        assert response.status_code == 204
        assert store.get(f"exp-{state}") is None
        assert not export_file.exists()


class TestExportFileResponses:
    def test_get_file_includes_metadata_headers(self, client: TestClient) -> None:
        export_id, _, status_payload = _run_export_and_download(client, _valid_body())
        response = client.get(_file_path(export_id))
        assert response.status_code == 200
        assert response.headers["content-length"] == str(status_payload["size_bytes"])
        assert "etag" in response.headers
        assert "last-modified" in response.headers
        assert response.content

    def test_head_file_returns_headers_without_body(self, client: TestClient) -> None:
        export_id, _, status_payload = _run_export_and_download(client, _valid_body())
        response = client.head(_file_path(export_id))
        assert response.status_code == 200
        assert response.headers["content-length"] == str(status_payload["size_bytes"])
        assert "etag" in response.headers
        assert "last-modified" in response.headers
        assert response.content == b""


class TestExportFormats:
    def test_csv_with_bom_includes_utf8_bom(self, client: TestClient) -> None:
        body = _valid_body()
        body["query"]["format"] = "csv_with_bom"

        response = client.post(_submit_path(), json=body)
        assert response.status_code == 202
        export_id = response.json()["export_id"]

        _wait_for_complete(client, export_id)
        file_response = client.get(_file_path(export_id))
        assert file_response.content.startswith(b"\xef\xbb\xbf")

    def test_ndjson_produces_one_json_object_per_line(self, client: TestClient) -> None:
        body = _valid_body()
        body["query"]["format"] = "ndjson"

        response = client.post(_submit_path(), json=body)
        assert response.status_code == 202
        export_id = response.json()["export_id"]

        _wait_for_complete(client, export_id)
        file_response = client.get(_file_path(export_id))
        lines = [line for line in file_response.text.splitlines() if line]
        assert lines
        parsed = [json.loads(line) for line in lines]
        assert all(isinstance(item, dict) for item in parsed)
        assert {"symbol", "total_volume"} <= set(parsed[0].keys())


class TestExportErrors:
    def test_dataset_not_found(self, client: TestClient) -> None:
        r = client.post(_submit_path("nonexistent"), json=_valid_body())
        assert r.status_code == 404

    def test_dataset_unavailable_in_sample_table_mode(self, client: TestClient, monkeypatch) -> None:
        """In sample_table mode, missing DuckDB table returns 409 DATASET_UNAVAILABLE."""
        from server.config import get_settings
        from server.engine import db_manager

        monkeypatch.setenv("QUERYSERVICE_EXECUTION_MODE", "sample_table")
        get_settings.cache_clear()
        monkeypatch.setattr(db_manager, "table_exists", lambda _: False)
        r = client.post(_submit_path(), json=_valid_body())
        get_settings.cache_clear()
        assert r.status_code == 409
        assert r.json()["code"] == "DATASET_UNAVAILABLE"

    def test_dataset_available_in_parquet_partitioned_mode(self, client: TestClient, monkeypatch) -> None:
        """In parquet_partitioned mode, no DuckDB table check is performed at submission time."""
        from server.config import get_settings
        from server.engine import db_manager

        monkeypatch.setenv("QUERYSERVICE_EXECUTION_MODE", "parquet_partitioned")
        get_settings.cache_clear()
        monkeypatch.setattr(db_manager, "table_exists", lambda _: False)
        r = client.post(_submit_path(), json=_valid_body())
        get_settings.cache_clear()
        assert r.status_code == 202
        assert r.json()["status"] == "pending"

    def test_get_export_not_found(self, client: TestClient) -> None:
        r = client.get("/api/v1/exports/exp-nonexistent")
        assert r.status_code == 404

    def test_download_not_found(self, client: TestClient) -> None:
        r = client.get(_file_path("exp-nonexistent"))
        assert r.status_code == 404

    def test_download_not_ready(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-test", "trades_v1", "csv")
        store.update_status("exp-test", "processing")
        r = client.get(_file_path("exp-test"))
        assert r.status_code == 409

    def test_download_for_failed_export(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-fail", "trades_v1", "csv")
        store.update_status("exp-fail", "processing")
        store.update_status("exp-fail", "failed", error_message="boom")
        r = client.get(_file_path("exp-fail"))
        assert r.status_code == 409

    def test_download_file_missing_on_disk(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-gone", "trades_v1", "csv")
        store.update_status("exp-gone", "processing")
        store.update_status(
            "exp-gone", "complete",
            file_path="/tmp/nonexistent-file.csv",
            download_url=_file_path("exp-gone"),
        )
        r = client.get(_file_path("exp-gone"))
        assert r.status_code == 404


class TestExportConcurrencyAndTtl:
    def test_max_concurrent_limit(self, client: TestClient) -> None:
        store = get_export_service().store
        for i in range(5):
            store.create(f"exp-active-{i}", "trades_v1", "csv")
            store.update_status(f"exp-active-{i}", "processing")
        r = client.post(_submit_path(), json=_valid_body())
        assert r.status_code == 429
        assert r.json()["code"] == "TOO_MANY_EXPORTS"

    def test_ttl_cleanup(self, client: TestClient, tmp_path) -> None:
        store = get_export_service().store
        expired_file = tmp_path / "exp-old.csv"
        expired_file.write_text("old data")
        store.create("exp-old", "trades_v1", "csv")
        store.update_status("exp-old", "processing")
        store.update_status("exp-old", "complete", file_path=str(expired_file))
        with store._lock:
            store._conn.execute(
                "UPDATE export_jobs SET created_at = ? WHERE id = ?",
                (time.time() - 7200, "exp-old"),
            )
            store._conn.commit()

        r = client.post(_submit_path(), json=_valid_body())
        assert r.status_code == 202
        assert store.get("exp-old").status == "expired"
        assert not expired_file.exists()

    def test_ttl_preserves_recent_completed_exports(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-recent", "trades_v1", "csv")
        store.update_status("exp-recent", "processing")
        store.update_status("exp-recent", "complete", file_path="/tmp/f.csv")
        r = client.post(_submit_path(), json=_valid_body())
        assert r.status_code == 202
        job = store.get("exp-recent")
        assert job is not None
        assert job.status == "complete"

    def test_multiple_exports_unique_ids(self, client: TestClient) -> None:
        r1 = client.post(_submit_path(), json=_valid_body())
        r2 = client.post(_submit_path(), json=_valid_body())
        assert r1.json()["export_id"] != r2.json()["export_id"]
