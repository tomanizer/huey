# QueryService Backend Documentation

This documentation set covers the Huey backend service (`server/`), called **QueryService**. It is the API layer used by the frontend (or other clients) to fetch schema metadata, run OLAP-style queries, and generate exports.

## Documentation Map

- [API Reference](./api-reference.md)
- [Configuration Reference](./configuration-reference.md)
- [Troubleshooting and FAQ](./troubleshooting.md)
- [Architecture Walkthrough](../../server/docs/architecture.md)

## 1. Overview and Description

QueryService is a Python FastAPI service that runs analytical SQL against DuckDB and exposes HTTP endpoints for:

- Dataset discovery (`/api/v1/datasets`, `/api/v1/datasets/{dataset_id}`)
- Dataset schema discovery (`/api/v1/datasets/{dataset_id}/schema`)
- Distinct tuples, picklists, and aggregated cells (`/api/v1/datasets/{dataset_id}/query/*`)
- Async export jobs (submit via `/api/v1/datasets/{dataset_id}/exports`, then poll/list under `/api/v1/exports*`) with durable job state in SQLite
- Health probes (`/health/*`)

In the Huey architecture, this service is the backend execution layer behind the frontend query UI.

## 2. Purpose and Use Cases

Primary problems this service solves:

- Centralized query execution over configured datasets
- Safe, schema-aware SQL generation for frontend-driven analytics
- Async export generation for large result sets
- Standardized machine-readable error responses for integration

Typical users:

- Frontend/client engineers integrating analytics calls
- Backend/integration engineers consuming APIs from other services
- Ops/SRE teams deploying and operating the service

Typical workflows:

1. Discover datasets with `GET /api/v1/datasets` and inspect metadata with `GET /api/v1/datasets/{dataset_id}`.
2. Fetch the lightweight field list with `GET /api/v1/datasets/{dataset_id}/schema`.
3. Build interactive queries with `POST /api/v1/datasets/{dataset_id}/query/tuples`, `POST /api/v1/datasets/{dataset_id}/query/cells`, `POST /api/v1/datasets/{dataset_id}/query/members`.
4. Trigger async export with `POST /api/v1/datasets/{dataset_id}/exports`, poll with `GET /api/v1/exports/{export_id}`, then download from `GET /api/v1/exports/{export_id}/file`.

## 3. Installation and Setup

### Prerequisites

- Python `3.11+` (enforced at runtime)
- `pip`
- Optional: Docker
- Optional for S3 partition execution: AWS credentials + network access to S3

### Local setup

From repo root:

```bash
python3 -m venv .venv-server
./.venv-server/bin/pip install -r server/requirements.txt
```

Dataset configuration defaults to [`server/datasets_config/datasets.yaml`](../../server/datasets_config/datasets.yaml). Override via `QUERYSERVICE_DATASETS_CONFIG_PATH`.

Environment variables are loaded from `.env` in the working directory (optional).

For all environment variables and defaults, see [Configuration Reference](./configuration-reference.md).

### Local development vs production

- Local dev defaults to in-memory DuckDB when `QUERYSERVICE_DATA_DIR` is unset.
- Production should set explicit persistent paths for:
  - `QUERYSERVICE_DATA_DIR` (if you need persistent DuckDB database file)
  - `QUERYSERVICE_EXPORT_OUTPUT_DIR`
  - `QUERYSERVICE_EXPORT_DB_PATH`

## 4. Running the Server

### Development

From repo root:

```bash
./.venv-server/bin/uvicorn server.main:app --host 0.0.0.0 --port 8000
```

Or:

```bash
PYTHONPATH=. ./.venv-server/bin/python -m server.main
```

### Production

Container option:

```bash
docker build -f server/Dockerfile -t query-service .
docker run -p 8000:8000 \
  -e UVICORN_WORKERS=1 \
  query-service
```

Non-container option (example process manager pattern):

```bash
PYTHONPATH=. ./.venv-server/bin/uvicorn server.main:app --host 0.0.0.0 --port 8000 --workers 1
```

### Network and ports

- Default bind host: `0.0.0.0`
- Default port: `8000`
- CORS is controlled by `QUERYSERVICE_CORS_ORIGINS`

## 5. Usage and Integration Guide

### Authentication model

- Auth is disabled by default (`QUERYSERVICE_AUTH_ENABLED=false`)
- When enabled, clients must send `X-API-Key`
- Health endpoints remain accessible without API key

### Request and response metadata

- `X-Request-ID` can be supplied by clients and is echoed back in responses.
- `X-Client-Version` can be supplied by clients and is included in server logs.
- API responses include `X-API-Version: 1`.
- When rate limiting is enabled, API responses include `X-RateLimit-*` headers, and `429` responses include `Retry-After`.

### Request conventions

- Query requests include the dataset in the URL path; export submission uses `POST /api/v1/datasets/{dataset_id}/exports` with a body containing `date_range` and `query`
- `date_range` supports:
  - `{"type": "single", "date": "YYYY-MM-DD"}`
  - `{"type": "range", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}`
- Date parsing is strict (real calendar dates only)

### Error handling conventions

Domain + validation errors use this envelope:

```json
{
  "code": "DATASET_NOT_FOUND",
  "message": "Dataset not found: trades_v1",
  "request_id": "...",
  "details": {"dataset_id": "trades_v1"}
}
```

Important API error codes:

- `DATASET_NOT_FOUND` (`404`)
- `DATASET_UNAVAILABLE` (`409`)
- `EXPORT_NOT_FOUND` (`404`)
- `EXPORT_NOT_READY` (`409`)
- `EXPORT_FILE_NOT_FOUND` (`404`)
- `TOO_MANY_EXPORTS` (`429`)
- `VALIDATION_ERROR` (`422`)
- `INTERNAL_ERROR` (`500`)

Notes:

- Auth failures return `401` using FastAPI `HTTPException` shape (`{"detail": ...}`)
- If rate limiting is enabled, `429` responses include `Retry-After`

## 6. API Documentation

See [API Reference](./api-reference.md) for full endpoint-by-endpoint request/response schemas, status codes, and examples.

Built-in interactive docs:

- `/api/v1/docs` (Swagger UI)
- `/api/v1/redoc`
- `/api/v1/openapi.json`

## 7. Examples and Recipes

### Recipe: start service + run a schema/query/export flow

Start service:

```bash
./.venv-server/bin/uvicorn server.main:app --host 0.0.0.0 --port 8000
```

Check schema:

```bash
curl 'http://localhost:8000/api/v1/datasets'
curl 'http://localhost:8000/api/v1/datasets/trades_v1'
curl 'http://localhost:8000/api/v1/datasets/trades_v1/schema'
```

Run tuples query:

```bash
curl -X POST 'http://localhost:8000/api/v1/datasets/trades_v1/query/tuples' \
  -H 'Content-Type: application/json' \
  -d '{
    "date_range": {"type": "single", "date": "2026-03-01"},
    "fields": [{"field": "symbol", "sort": "ASC"}],
    "paging": {"limit": 10, "offset": 0}
  }'
```

Create export (default format is parquet):

```bash
curl -X POST 'http://localhost:8000/api/v1/datasets/trades_v1/exports' \
  -H 'Content-Type: application/json' \
  -d '{
    "date_range": {"type": "single", "date": "2026-03-01"},
    "query": {
      "axes": {
        "rows": [{"field": "symbol"}],
        "measures": [{"field": "volume", "aggregation": "SUM", "alias": "total_volume"}]
      },
      "max_rows": 1000
    }
  }'
```

Poll + download:

```bash
curl 'http://localhost:8000/api/v1/exports/<export_id>'
curl -OJ 'http://localhost:8000/api/v1/exports/<export_id>/file'
```

### Example environment profiles

Local:

```env
QUERYSERVICE_LOG_LEVEL=INFO
QUERYSERVICE_LOG_FORMAT=text
QUERYSERVICE_SEED_SAMPLE_DATA=true
```

Staging:

```env
QUERYSERVICE_LOG_FORMAT=json
QUERYSERVICE_AUTH_ENABLED=true
QUERYSERVICE_API_KEYS=staging-key-1,staging-key-2
QUERYSERVICE_RATE_LIMIT_ENABLED=true
QUERYSERVICE_DATA_DIR=/var/lib/queryservice/query.duckdb
QUERYSERVICE_EXPORT_OUTPUT_DIR=/var/lib/queryservice/exports
QUERYSERVICE_EXPORT_DB_PATH=/var/lib/queryservice/exports/jobs.db
```

Production baseline:

```env
QUERYSERVICE_LOG_FORMAT=json
QUERYSERVICE_AUTH_ENABLED=true
QUERYSERVICE_RATE_LIMIT_ENABLED=true
QUERYSERVICE_DUCKDB_THREADS=4
QUERYSERVICE_DUCKDB_MEMORY_LIMIT=8GB
QUERYSERVICE_DUCKDB_TEMP_DIRECTORY=/tmp/huey-duckdb-tmp
QUERYSERVICE_EXPORT_OUTPUT_DIR=/srv/queryservice/exports
QUERYSERVICE_EXPORT_DB_PATH=/srv/queryservice/exports/jobs.db
```

### Query cache tuning presets

Query caching is disabled by default. When enabled, the cache uses a weighted in-memory LRU (L1) with an optional SQLite-backed overflow (L2). The table below shows three practical starting points:

#### Very low memory (≤ 512 MB total process)

Use a small L1, rely on L2 for spillover, and disable cells caching. Raise the admission threshold to avoid caching results from fast queries that don't benefit.

```env
QUERYSERVICE_CACHE_ENABLED=true
QUERYSERVICE_CACHE_MAX_BYTES=8388608          # 8 MB L1
QUERYSERVICE_CACHE_MAX_ITEM_BYTES=524288      # 512 KB max per item
QUERYSERVICE_CACHE_TTL_SECONDS=60
QUERYSERVICE_CACHE_ADMISSION_MIN_DURATION_MS=50
QUERYSERVICE_CACHE_SQLITE_PATH=/tmp/huey-cache/l2.db
QUERYSERVICE_CACHE_SQLITE_MAX_BYTES=67108864  # 64 MB L2
QUERYSERVICE_DUCKDB_THREADS=1
QUERYSERVICE_DUCKDB_MEMORY_LIMIT=256MB
QUERYSERVICE_MAX_CONCURRENT_QUERIES=2
QUERYSERVICE_MAX_QUERY_QUEUE_DEPTH=4
```

#### Default balanced (1–4 GB available)

Suitable for most deployments. L1 holds frequent hot results; L2 extends cache lifetime to disk.

```env
QUERYSERVICE_CACHE_ENABLED=true
QUERYSERVICE_CACHE_MAX_BYTES=67108864         # 64 MB L1 (default)
QUERYSERVICE_CACHE_MAX_ITEM_BYTES=1048576     # 1 MB max per item (default)
QUERYSERVICE_CACHE_TTL_SECONDS=120            # 2 min TTL (default)
QUERYSERVICE_CACHE_ADMISSION_MIN_DURATION_MS=0
QUERYSERVICE_CACHE_SQLITE_PATH=/tmp/huey-cache/l2.db
QUERYSERVICE_CACHE_SQLITE_MAX_BYTES=268435456 # 256 MB L2 (default)
```

#### High-throughput (8+ GB available, many concurrent users)

Increase L1 budget, use a longer TTL, and raise concurrency to maximize hit rate for repeated analytics patterns.

```env
QUERYSERVICE_CACHE_ENABLED=true
QUERYSERVICE_CACHE_MAX_BYTES=536870912        # 512 MB L1
QUERYSERVICE_CACHE_MAX_ITEM_BYTES=4194304     # 4 MB max per item
QUERYSERVICE_CACHE_TTL_SECONDS=300            # 5 min TTL
QUERYSERVICE_CACHE_ADMISSION_MIN_DURATION_MS=0
QUERYSERVICE_CACHE_SQLITE_PATH=/var/lib/queryservice/cache/l2.db
QUERYSERVICE_CACHE_SQLITE_MAX_BYTES=2147483648  # 2 GB L2
QUERYSERVICE_DUCKDB_THREADS=8
QUERYSERVICE_DUCKDB_MEMORY_LIMIT=16GB
QUERYSERVICE_MAX_CONCURRENT_QUERIES=16
```

> **Note:** `QUERYSERVICE_CACHE_MAX_ITEM_BYTES` applies a per-item size cap. Items larger than this cap are never stored in L1 even if the total L1 budget would allow it. For cells queries, the effective cap is halved automatically (see architecture docs).

## 8. Operational Considerations

### Logging and monitoring

- JSON/text logging controlled by `QUERYSERVICE_LOG_FORMAT`
- Access logs include method/path/status/duration
- Query logs include endpoint-level timing and row counts
- Correlation IDs are supported through `X-Request-ID`

### Health checks

- `GET /health/liveness`: process is up
- `GET /health/readiness`: backend ready (DuckDB health check)

### Scaling and performance

- DuckDB tuning settings:
  - `QUERYSERVICE_DUCKDB_THREADS`
  - `QUERYSERVICE_DUCKDB_MEMORY_LIMIT`
  - `QUERYSERVICE_DUCKDB_TEMP_DIRECTORY`
  - `QUERYSERVICE_DUCKDB_ENABLE_OBJECT_CACHE`
- Keep total execution threads aligned with available CPU when using multiple workers
- Export capacity is bounded by `QUERYSERVICE_EXPORT_MAX_CONCURRENT`

### Backup/restore and retention

- Export job metadata is in SQLite (`QUERYSERVICE_EXPORT_DB_PATH`)
- Export artifacts are files in `QUERYSERVICE_EXPORT_OUTPUT_DIR`
- Completed/failed exports are marked expired and cleaned up after `QUERYSERVICE_EXPORT_TTL_SECONDS`
- If retention/compliance is strict, run external backup/retention controls on these paths

### Migrations

- No dedicated schema migration framework is currently used for the export SQLite DB
- Validate compatibility before manual DB schema changes

## 9. Security and Compliance

- API keys are configured via env (`QUERYSERVICE_API_KEYS`) when auth is enabled
- CORS is explicitly configured via `QUERYSERVICE_CORS_ORIGINS`
- TLS termination is expected to be handled by ingress/proxy (not built into app)
- Do not commit secrets to repo; provide via runtime environment/secret manager
- Review dataset content classification before enabling exports in regulated environments

## 10. Troubleshooting and FAQ

See [Troubleshooting and FAQ](./troubleshooting.md) for common failures and debugging commands.
