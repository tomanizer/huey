# Backend load testing (QueryService)

This document describes how to run load tests against the QueryService API (C3.1).

## Scope

- Concurrent requests to `/api/v1/datasets/{dataset_id}/schema`, `/api/v1/datasets/{dataset_id}/query/tuples`, `/api/v1/datasets/{dataset_id}/query/cells`, `/api/v1/datasets/{dataset_id}/query/picklist`.
- Metrics: request count, success rate, latency percentiles (p50, p90, p99).

## Prerequisites

- QueryService running (e.g. `uvicorn server.main:app --port 8000`).
- Python 3.9+ (stdlib only for the script below).

## Running the load test script

From repo root:

```bash
# Start the server in another terminal:
# cd server && uvicorn server.main:app --port 8000

python scripts/load_test_query_service.py --base-url http://127.0.0.1:8000 --workers 4 --requests 100
```

Options:

- `--base-url`: QueryService base URL (default: `http://127.0.0.1:8000`).
- `--workers`: Number of concurrent workers (default: 4).
- `--requests`: Total number of requests to send (default: 100).

Output: success count, failure count, and latency percentiles (p50, p90, p99) per endpoint.

## Export scan benchmark

To compare prior dual-scan export execution (`COUNT(*)` + `COPY`) with single-scan (`COPY` only):

```bash
python scripts/benchmark_export_scan_strategies.py --rows 2000000
```

The script prints elapsed seconds for both approaches and the percentage improvement for the single-scan path.

## Interpreting results

- **Success rate:** Should be 100% under normal load; drops indicate errors or timeouts.
- **Latency:** Use p90/p99 to spot slow endpoints or degradation under concurrency.
- Run with increasing `--workers` and `--requests` to find a baseline before adding timeouts and resource limits (see A6.2).
