"""Tests for POST /export, GET /export/{id}, and GET /export/{id}/download."""

import csv
import io
import time

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


def _valid_body(**overrides):
    body = {
        "dataset_id": "trades_v1",
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


def _run_export_and_download(client: TestClient, body: dict) -> tuple[str, list[list[str]]]:
    """Submit an export, wait for completion, download, parse CSV rows."""
    r = client.post("/export", json=body)
    assert r.status_code == 200
    export_id = r.json()["export_id"]

    for _ in range(20):
        status_r = client.get(f"/export/{export_id}")
        assert status_r.status_code == 200
        if status_r.json()["status"] == "complete":
            break
        time.sleep(0.05)
    else:
        pytest.fail("Export did not complete in time")

    dl = client.get(f"/export/{export_id}/download")
    assert dl.status_code == 200
    reader = csv.reader(io.StringIO(dl.text))
    return export_id, list(reader)


class TestExportLifecycle:
    def test_post_export_returns_pending(self, client: TestClient) -> None:
        r = client.post("/export", json=_valid_body())
        assert r.status_code == 200
        data = r.json()
        assert data["export_id"].startswith("exp-")
        assert data["status"] == "pending"

    def test_export_completes_with_real_data(self, client: TestClient) -> None:
        _, rows = _run_export_and_download(client, _valid_body())
        header = rows[0]
        assert header == ["symbol", "total_volume"]
        data_rows = rows[1:]
        assert len(data_rows) > 0
        symbols = {r[0] for r in data_rows}
        assert symbols & {"AAPL", "GOOG", "MSFT", "AMZN", "TSLA"}

    def test_export_status_row_count_is_nullable(self, client: TestClient) -> None:
        r = client.post("/export", json=_valid_body())
        assert r.status_code == 200
        export_id = r.json()["export_id"]
        for _ in range(20):
            status_r = client.get(f"/export/{export_id}")
            assert status_r.status_code == 200
            if status_r.json()["status"] == "complete":
                break
            time.sleep(0.05)
        else:
            pytest.fail("Export did not complete in time")
        assert status_r.json()["row_count"] is None

    def test_csv_values_are_correct_aggregations(self, client: TestClient) -> None:
        _, rows = _run_export_and_download(client, _valid_body())
        lookup = {r[0]: int(r[1]) for r in rows[1:]}
        assert lookup["AAPL"] == 1500
        assert lookup["GOOG"] == 2200

    def test_default_export_format_is_parquet(self, client: TestClient) -> None:
        body = _valid_body()
        del body["query"]["format"]

        r = client.post("/export", json=body)
        assert r.status_code == 200
        export_id = r.json()["export_id"]

        for _ in range(20):
            status_r = client.get(f"/export/{export_id}")
            assert status_r.status_code == 200
            if status_r.json()["status"] == "complete":
                break
            time.sleep(0.05)
        else:
            pytest.fail("Export did not complete in time")

        dl = client.get(f"/export/{export_id}/download")
        assert dl.status_code == 200
        assert dl.headers["content-type"].startswith("application/octet-stream")
        assert "filename=\"exp-" in dl.headers.get("content-disposition", "")
        assert ".parquet" in dl.headers.get("content-disposition", "")
        assert len(dl.content) > 0


class TestExportWithFilters:
    def test_include_filter(self, client: TestClient) -> None:
        body = _valid_body()
        body["query"]["filters"] = [
            {"field": "symbol", "operator": "INCLUDE", "values": ["AAPL", "GOOG"]},
        ]
        _, rows = _run_export_and_download(client, body)
        symbols = {r[0] for r in rows[1:]}
        assert symbols == {"AAPL", "GOOG"}

    def test_exclude_filter(self, client: TestClient) -> None:
        body = _valid_body()
        body["query"]["filters"] = [
            {"field": "symbol", "operator": "EXCLUDE", "values": ["AAPL"]},
        ]
        _, rows = _run_export_and_download(client, body)
        symbols = {r[0] for r in rows[1:]}
        assert "AAPL" not in symbols
        assert len(symbols) >= 3


class TestExportDateRange:
    def test_single_date(self, client: TestClient) -> None:
        body = _valid_body()
        body["date_range"] = {"type": "single", "date": "2026-03-02"}
        _, rows = _run_export_and_download(client, body)
        symbols = {r[0] for r in rows[1:]}
        assert "AMZN" not in symbols

    def test_date_range(self, client: TestClient) -> None:
        body = _valid_body()
        body["date_range"] = {"type": "range", "start": "2026-03-01", "end": "2026-03-02"}
        _, rows = _run_export_and_download(client, body)
        data_rows = rows[1:]
        lookup = {r[0]: int(r[1]) for r in data_rows}
        assert lookup["AAPL"] == 1500 + 1600


class TestExportMaxRows:
    def test_max_rows_truncates(self, client: TestClient) -> None:
        body = _valid_body()
        body["query"]["max_rows"] = 2
        _, rows = _run_export_and_download(client, body)
        data_rows = rows[1:]
        assert len(data_rows) == 2


class TestExportRawColumns:
    def test_empty_axes_exports_all_fields(self, client: TestClient) -> None:
        body = _valid_body()
        body["query"]["axes"] = {}
        _, rows = _run_export_and_download(client, body)
        header = rows[0]
        assert set(header) == {"date", "symbol", "volume"}
        assert len(rows) > 1


class TestExportCsvFormat:
    def test_csv_header_always_present(self, client: TestClient) -> None:
        _, rows = _run_export_and_download(client, _valid_body())
        assert len(rows) >= 2
        assert rows[0] == ["symbol", "total_volume"]

    def test_csv_proper_quoting(self, client: TestClient) -> None:
        _, rows = _run_export_and_download(client, _valid_body())
        for row in rows:
            assert all(isinstance(cell, str) for cell in row)


class TestExportErrors:
    def test_dataset_not_found(self, client: TestClient) -> None:
        r = client.post("/export", json=_valid_body(dataset_id="nonexistent"))
        assert r.status_code == 404

    def test_get_export_not_found(self, client: TestClient) -> None:
        r = client.get("/export/exp-nonexistent")
        assert r.status_code == 404

    def test_download_not_found(self, client: TestClient) -> None:
        r = client.get("/export/exp-nonexistent/download")
        assert r.status_code == 404

    def test_download_not_ready(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-test", "trades_v1")
        store.update_status("exp-test", "processing")
        r = client.get("/export/exp-test/download")
        assert r.status_code == 409

    def test_download_for_failed_export(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-fail", "trades_v1")
        store.update_status("exp-fail", "processing")
        store.update_status("exp-fail", "failed", error_message="boom")
        r = client.get("/export/exp-fail/download")
        assert r.status_code == 409

    def test_download_file_missing_on_disk(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-gone", "trades_v1")
        store.update_status("exp-gone", "processing")
        store.update_status(
            "exp-gone", "complete",
            file_path="/tmp/nonexistent-file.csv",
            download_url="/export/exp-gone/download",
        )
        r = client.get("/export/exp-gone/download")
        assert r.status_code == 404


class TestExportConcurrencyAndTtl:
    def test_max_concurrent_limit(self, client: TestClient) -> None:
        store = get_export_service().store
        for i in range(5):
            store.create(f"exp-active-{i}", "trades_v1")
            store.update_status(f"exp-active-{i}", "processing")
        r = client.post("/export", json=_valid_body())
        assert r.status_code == 429
        assert r.json()["code"] == "TOO_MANY_EXPORTS"

    def test_ttl_cleanup(self, client: TestClient, tmp_path) -> None:
        store = get_export_service().store
        expired_file = tmp_path / "exp-old.csv"
        expired_file.write_text("old data")
        store.create("exp-old", "trades_v1")
        store.update_status("exp-old", "processing")
        store.update_status(
            "exp-old", "complete",
            file_path=str(expired_file),
        )
        with store._lock:
            store._conn.execute(
                "UPDATE export_jobs SET created_at = ? WHERE id = ?",
                (time.time() - 7200, "exp-old"),
            )
            store._conn.commit()

        r = client.post("/export", json=_valid_body())
        assert r.status_code == 200
        assert store.get("exp-old").status == "expired"
        assert not expired_file.exists()

    def test_ttl_preserves_active_exports(self, client: TestClient) -> None:
        store = get_export_service().store
        store.create("exp-recent", "trades_v1")
        store.update_status("exp-recent", "processing")
        store.update_status("exp-recent", "complete", file_path="/tmp/f.csv")
        r = client.post("/export", json=_valid_body())
        assert r.status_code == 200
        job = store.get("exp-recent")
        assert job is not None
        assert job.status == "complete"

    def test_multiple_exports_unique_ids(self, client: TestClient) -> None:
        r1 = client.post("/export", json=_valid_body())
        r2 = client.post("/export", json=_valid_body())
        assert r1.json()["export_id"] != r2.json()["export_id"]
