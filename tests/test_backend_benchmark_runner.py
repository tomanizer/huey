"""Smoke tests for backend benchmark runner and workflow artifact path."""

from __future__ import annotations

import json
import socket
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread


class _BenchmarkHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        self.rfile.read(int(self.headers.get("content-length", "0")))
        if self.path in {
            "/api/v1/datasets/trades_v1/query/tuples",
            "/api/v1/datasets/trades_v1/query/cells",
            "/api/v1/datasets/trades_v1/query/picklist",
            "/api/v1/exports",
        }:
            payload = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("x-bytes-scanned", "123")
            self.send_header("x-spill-bytes", "7")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def test_benchmark_runner_smoke(tmp_path: Path) -> None:
    repo = Path(__file__).resolve().parents[1]
    script = repo / "scripts" / "backend_benchmark_runner.py"
    output_dir = tmp_path / "bench"

    port = _free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), _BenchmarkHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    thresholds = {
        "mode": "warn",
        "endpoints": {
            "tuples": {"max_p95_ms": 0},
            "cells": {},
            "picklist": {},
            "export": {},
        },
    }
    thresholds_path = tmp_path / "thresholds.json"
    thresholds_path.write_text(json.dumps(thresholds), encoding="utf-8")

    try:
        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--base-url",
                f"http://127.0.0.1:{port}",
                "--requests-per-endpoint",
                "1",
                "--workers",
                "1",
                "--thresholds",
                str(thresholds_path),
                "--output-dir",
                str(output_dir),
            ],
            cwd=repo,
            check=False,
            capture_output=True,
            text=True,
        )
    finally:
        server.shutdown()

    assert result.returncode == 0, result.stderr

    report_json = output_dir / "benchmark-report.json"
    report_csv = output_dir / "benchmark-report.csv"
    summary_md = output_dir / "benchmark-summary.md"
    assert report_json.exists()
    assert report_csv.exists()
    assert summary_md.exists()

    report = json.loads(report_json.read_text(encoding="utf-8"))
    assert set(report["summary"]) == {
        "tuples_symbol",
        "tuples_symbol_filtered",
        "cells_symbol_sum_volume",
        "cells_date_symbol_sum_volume",
        "picklist_symbol",
        "picklist_symbol_search",
        "export_csv_symbol_volume",
    }
    for metrics in report["summary"].values():
        assert metrics["requests"] == 1
    assert any("tuples_symbol" in warning for warning in report["warnings"])


def test_benchmark_workflow_upload_path() -> None:
    workflow = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "backend-benchmarks-nightly.yml"
    text = workflow.read_text(encoding="utf-8")
    assert "uses: actions/upload-artifact@v4" in text
    assert "path: artifacts/benchmarks/nightly" in text
