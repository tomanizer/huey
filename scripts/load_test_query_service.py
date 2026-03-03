#!/usr/bin/env python3
"""
Load test script for QueryService (schema, tuples, cells, picklist).
Uses stdlib only. Run with the server up: python scripts/load_test_query_service.py --base-url http://127.0.0.1:8000
"""

import argparse
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed


def request(base_url: str, path: str, method: str = "GET", body: dict | None = None) -> tuple[bool, float]:
    url = f"{base_url.rstrip('/')}{path}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
        return True, time.perf_counter() - start
    except Exception:
        return False, time.perf_counter() - start


def run_one(base_url: str, dataset_id: str, date_range: dict) -> list[tuple[str, bool, float]]:
    results = []
    # GET /schema
    ok, lat = request(base_url, f"/schema?dataset_id={dataset_id}")
    results.append(("schema", ok, lat))
    # POST /query/tuples
    ok, lat = request(
        base_url,
        "/query/tuples",
        method="POST",
        body={
            "dataset_id": dataset_id,
            "date_range": date_range,
            "query": {"axis": "rows", "fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 0}},
        },
    )
    results.append(("tuples", ok, lat))
    # POST /query/cells
    ok, lat = request(
        base_url,
        "/query/cells",
        method="POST",
        body={
            "dataset_id": dataset_id,
            "date_range": date_range,
            "query": {
                "rows": {"start_index": 0, "count": 5},
                "columns": {"start_index": 0, "count": 5},
                "axes": {"rows": [], "columns": [], "measures": []},
                "filters": [],
            },
        },
    )
    results.append(("cells", ok, lat))
    # POST /query/picklist
    ok, lat = request(
        base_url,
        "/query/picklist",
        method="POST",
        body={
            "dataset_id": dataset_id,
            "date_range": date_range,
            "query": {"field": "symbol", "search": "", "filters": [], "paging": {"limit": 100, "offset": 0}},
        },
    )
    results.append(("picklist", ok, lat))
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description="Load test QueryService")
    ap.add_argument("--base-url", default="http://127.0.0.1:8000", help="QueryService base URL")
    ap.add_argument("--workers", type=int, default=4, help="Concurrent workers")
    ap.add_argument("--requests", type=int, default=100, help="Total requests (each request = one full flow)")
    ap.add_argument("--dataset-id", default="trades_v1", help="Dataset ID")
    args = ap.parse_args()
    base_url = args.base_url.rstrip("/")
    date_range = {"type": "single", "date": "2026-03-01"}

    by_endpoint: dict[str, list[tuple[bool, float]]] = {"schema": [], "tuples": [], "cells": [], "picklist": []}
    total = args.requests

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = [
            ex.submit(run_one, base_url, args.dataset_id, date_range)
            for _ in range(total)
        ]
        for f in as_completed(futures):
            try:
                for name, ok, lat in f.result():
                    by_endpoint[name].append((ok, lat))
            except Exception as e:
                print(f"Worker error: {e}", file=sys.stderr)
                for name in by_endpoint:
                    by_endpoint[name].append((False, 0.0))

    print(f"Total flows: {total}\n")
    for name in ["schema", "tuples", "cells", "picklist"]:
        items = by_endpoint[name]
        ok_count = sum(1 for ok, _ in items if ok)
        latencies = [lat for _, lat in items if lat > 0]
        print(f"  {name}: success {ok_count}/{len(items)}")
        if latencies:
            latencies.sort()
            n = len(latencies)
            p50 = latencies[int(n * 0.5)] * 1000
            p90 = latencies[int(n * 0.9)] * 1000 if n >= 10 else latencies[-1] * 1000
            p99 = latencies[int(n * 0.99)] * 1000 if n >= 100 else latencies[-1] * 1000
            print(f"    latency ms: p50={p50:.1f} p90={p90:.1f} p99={p99:.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
