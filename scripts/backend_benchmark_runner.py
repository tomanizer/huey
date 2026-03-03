#!/usr/bin/env python3
"""Backend benchmark runner for tuples/cells/picklist/export endpoints."""

from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import socket
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class RequestResult:
    endpoint: str
    ok: bool
    latency_ms: float
    status_code: int
    response_bytes: int
    bytes_scanned: int
    spill_bytes: int
    timed_out: bool


def _percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round((len(ordered) - 1) * q)))
    return ordered[idx]


def _machine_metadata() -> dict[str, Any]:
    return {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "python_version": platform.python_version(),
        "cpu_count": os.cpu_count(),
    }


def _request(base_url: str, workload: dict[str, Any], timeout: float) -> RequestResult:
    data = None
    body = workload.get("body")
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}{workload['path']}",
        data=data,
        method=workload.get("method", "GET"),
    )
    if data is not None:
        req.add_header("Content-Type", "application/json")

    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            payload = response.read()
            latency_ms = (time.perf_counter() - started) * 1000.0
            headers = response.headers
            return RequestResult(
                endpoint=workload["name"],
                ok=200 <= response.status < 500,
                latency_ms=latency_ms,
                status_code=response.status,
                response_bytes=len(payload),
                bytes_scanned=int(headers.get("x-bytes-scanned", "0") or "0"),
                spill_bytes=int(headers.get("x-spill-bytes", "0") or "0"),
                timed_out=False,
            )
    except urllib.error.HTTPError as exc:
        latency_ms = (time.perf_counter() - started) * 1000.0
        return RequestResult(
            endpoint=workload["name"],
            ok=False,
            latency_ms=latency_ms,
            status_code=exc.code,
            response_bytes=0,
            bytes_scanned=0,
            spill_bytes=0,
            timed_out=False,
        )
    except Exception as exc:  # pragma: no cover - timeout and transient network errors
        latency_ms = (time.perf_counter() - started) * 1000.0
        timed_out = isinstance(exc, TimeoutError) or "timed out" in str(exc).lower()
        return RequestResult(
            endpoint=workload["name"],
            ok=False,
            latency_ms=latency_ms,
            status_code=0,
            response_bytes=0,
            bytes_scanned=0,
            spill_bytes=0,
            timed_out=timed_out,
        )


def _run(
    base_url: str,
    workloads: list[dict[str, Any]],
    requests_per_endpoint: int,
    workers: int,
    timeout: float,
) -> tuple[dict[str, list[RequestResult]], float]:
    by_endpoint: dict[str, list[RequestResult]] = {w["name"]: [] for w in workloads}
    tasks = [w for w in workloads for _ in range(requests_per_endpoint)]
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [executor.submit(_request, base_url, workload, timeout) for workload in tasks]
        for future in as_completed(futures):
            result = future.result()
            by_endpoint[result.endpoint].append(result)
    duration = max(time.perf_counter() - started, 1e-6)
    return by_endpoint, duration


def _summarize(
    by_endpoint: dict[str, list[RequestResult]],
    duration_seconds: float,
    thresholds: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    summary: dict[str, Any] = {}
    warnings: list[str] = []
    for endpoint, results in by_endpoint.items():
        latencies = [item.latency_ms for item in results]
        total = len(results)
        success = sum(1 for item in results if item.ok)
        errors = total - success
        timeouts = sum(1 for item in results if item.timed_out)
        timeout_error_rate = (timeouts + errors) / total if total else 0.0

        metrics = {
            "requests": total,
            "success": success,
            "errors": errors,
            "timeout_error_rate": timeout_error_rate,
            "throughput_rps": total / duration_seconds,
            "latency_ms": {
                "p50": _percentile(latencies, 0.50),
                "p95": _percentile(latencies, 0.95),
                "p99": _percentile(latencies, 0.99),
            },
            "bytes_scanned": sum(item.bytes_scanned for item in results),
            "response_bytes": sum(item.response_bytes for item in results),
            "spill_volume_bytes": sum(item.spill_bytes for item in results),
            "peak_rss_kb": _peak_rss_kb(),
        }
        summary[endpoint] = metrics

        endpoint_threshold = thresholds.get("endpoints", {}).get(endpoint, {})
        max_p95 = endpoint_threshold.get("max_p95_ms")
        max_timeout_error_rate = endpoint_threshold.get("max_timeout_error_rate")
        if max_p95 is not None and metrics["latency_ms"]["p95"] > max_p95:
            warnings.append(
                f"{endpoint}: p95 {metrics['latency_ms']['p95']:.2f}ms exceeds threshold {max_p95}ms"
            )
        if max_timeout_error_rate is not None and metrics["timeout_error_rate"] > max_timeout_error_rate:
            warnings.append(
                f"{endpoint}: timeout/error rate {metrics['timeout_error_rate']:.2%} exceeds threshold {max_timeout_error_rate:.2%}"
            )

    return summary, warnings


def _peak_rss_kb() -> int | None:
    try:
        import resource

        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    except Exception:
        return None


def _write_csv(path: Path, summary: dict[str, Any]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "endpoint",
                "requests",
                "success",
                "errors",
                "throughput_rps",
                "p50_ms",
                "p95_ms",
                "p99_ms",
                "bytes_scanned",
                "response_bytes",
                "peak_rss_kb",
                "spill_volume_bytes",
                "timeout_error_rate",
            ]
        )
        for endpoint, metrics in summary.items():
            writer.writerow(
                [
                    endpoint,
                    metrics["requests"],
                    metrics["success"],
                    metrics["errors"],
                    f"{metrics['throughput_rps']:.3f}",
                    f"{metrics['latency_ms']['p50']:.3f}",
                    f"{metrics['latency_ms']['p95']:.3f}",
                    f"{metrics['latency_ms']['p99']:.3f}",
                    metrics["bytes_scanned"],
                    metrics["response_bytes"],
                    metrics["peak_rss_kb"] if metrics["peak_rss_kb"] is not None else "",
                    metrics["spill_volume_bytes"],
                    f"{metrics['timeout_error_rate']:.5f}",
                ]
            )


def _write_markdown(path: Path, summary: dict[str, Any], warnings: list[str], mode: str) -> None:
    lines = [
        "# Backend benchmark summary",
        "",
        "| endpoint | requests | p50 (ms) | p95 (ms) | p99 (ms) | throughput (rps) | bytes scanned | peak RSS (KB) | spill volume (bytes) | timeout/error rate |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for endpoint, metrics in summary.items():
        lines.append(
            "| {endpoint} | {requests} | {p50:.2f} | {p95:.2f} | {p99:.2f} | {rps:.2f} | {bytes_scanned} | {peak_rss} | {spill} | {err:.2%} |".format(
                endpoint=endpoint,
                requests=metrics["requests"],
                p50=metrics["latency_ms"]["p50"],
                p95=metrics["latency_ms"]["p95"],
                p99=metrics["latency_ms"]["p99"],
                rps=metrics["throughput_rps"],
                bytes_scanned=metrics["bytes_scanned"],
                peak_rss=metrics["peak_rss_kb"] if metrics["peak_rss_kb"] is not None else "n/a",
                spill=metrics["spill_volume_bytes"],
                err=metrics["timeout_error_rate"],
            )
        )

    lines.append("")
    lines.append(f"Threshold mode: **{mode}**")
    if warnings:
        lines.append("")
        lines.append("## Warnings")
        for warning in warnings:
            lines.append(f"- {warning}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run backend benchmark workloads")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--dataset-id", default="trades_v1")
    parser.add_argument("--date", default="2026-03-01")
    parser.add_argument("--requests-per-endpoint", type=int, default=10)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--workloads", default="server/benchmarks/workloads.json")
    parser.add_argument("--thresholds", default="server/benchmarks/thresholds.json")
    parser.add_argument("--output-dir", default="artifacts/benchmarks/latest")
    args = parser.parse_args()

    workloads = json.loads(Path(args.workloads).read_text(encoding="utf-8"))["workloads"]
    for workload in workloads:
        body = workload.get("body")
        if isinstance(body, dict):
            body.setdefault("dataset_id", args.dataset_id)
            body.setdefault("date_range", {"type": "single", "date": args.date})

    thresholds = json.loads(Path(args.thresholds).read_text(encoding="utf-8"))
    by_endpoint, duration_seconds = _run(
        args.base_url,
        workloads,
        requests_per_endpoint=max(1, args.requests_per_endpoint),
        workers=args.workers,
        timeout=args.timeout,
    )
    summary, warnings = _summarize(by_endpoint, duration_seconds, thresholds)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "metadata": {
            **_machine_metadata(),
            "base_url": args.base_url,
            "dataset_id": args.dataset_id,
            "date": args.date,
            "requests_per_endpoint": args.requests_per_endpoint,
            "workers": args.workers,
            "timeout": args.timeout,
            "threshold_mode": thresholds.get("mode", "warn"),
            "duration_seconds": duration_seconds,
        },
        "workloads": workloads,
        "summary": summary,
        "warnings": warnings,
    }

    (output_dir / "benchmark-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    _write_csv(output_dir / "benchmark-report.csv", summary)
    _write_markdown(output_dir / "benchmark-summary.md", summary, warnings, thresholds.get("mode", "warn"))

    print(f"Benchmark artifacts written to {output_dir}")
    for warning in warnings:
        print(f"WARN: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
