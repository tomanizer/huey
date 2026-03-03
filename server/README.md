# QueryService

Huey OLAP query service backend (Python, FastAPI, DuckDB). Serves health checks and will expose schema and query APIs per the [tech spec](../docs/huey-large-scale-olap-tech-spec.md). See the [architecture guide](./docs/architecture.md) for a deeper walkthrough.

## Setup

From the repo root:

```bash
python3 --version  # requires Python 3.11+
python3 -m venv .venv-server
./.venv-server/bin/pip install -r server/requirements.txt
```

## Run

From the repo root (so `server` is the package):

```bash
./.venv-server/bin/uvicorn server.main:app --host 0.0.0.0 --port 8000
```

Or:

```bash
PYTHONPATH=. ./.venv-server/bin/python -m server.main
```

## Health

- `GET /health/liveness` – process is up
- `GET /health/readiness` – ready for traffic (engine/S3 checks added in later issues)

## API

- `GET /schema` – return schema metadata for a dataset (`dataset_id` query param)
- `POST /query/tuples` – distinct dimension tuples with paging
- `POST /query/cells` – aggregated cell values grouped by dimensions/measures
- `POST /query/picklist` – distinct values for a field with search/paging
- `POST /export` – submit an export job (background processing)
- `GET /export/{export_id}` – poll export status/download URL
- `GET /export/{export_id}/download` – download completed CSV
- `GET /health/liveness` – liveness probe
- `GET /health/readiness` – readiness probe

## Tests

From the repo root:

```bash
PYTHONPATH=. ./.venv-server/bin/python -m pytest server/tests -v
```

To include coverage:

```bash
PYTHONPATH=. ./.venv-server/bin/python -m pytest server/tests --cov=server --cov-report=term-missing
```

## Docker

From the repo root:

```bash
docker build -f server/Dockerfile -t query-service .
docker run -p 8000:8000 query-service
```

## Config

Environment variables (prefix `QUERYSERVICE_`):

- `QUERYSERVICE_HOST` (default `0.0.0.0`)
- `QUERYSERVICE_PORT` (default `8000`)
- `QUERYSERVICE_LOG_LEVEL` (default `INFO`)
- `QUERYSERVICE_LOG_FORMAT` (default `text`, set `json` for structured logs)
- `QUERYSERVICE_DATASETS_CONFIG_PATH` (default bundled `datasets_config/datasets.yaml`)
- `QUERYSERVICE_SEED_SAMPLE_DATA` (default `true`)
- `QUERYSERVICE_DATA_DIR` (default `None`, DuckDB in-memory; set to persist)
- `QUERYSERVICE_EXPORT_TTL_SECONDS` (default `3600`)
- `QUERYSERVICE_EXPORT_MAX_CONCURRENT` (default `5`)
- `QUERYSERVICE_EXPORT_OUTPUT_DIR` (default `/tmp/huey-exports`)
- `QUERYSERVICE_EXPORT_DB_PATH` (default `/tmp/huey-exports/jobs.db`)
- `QUERYSERVICE_S3_BUCKET` (default `None`)
- `QUERYSERVICE_S3_REGION` (default `None`)
- `QUERYSERVICE_SCHEMA_CACHE_TTL_SECONDS` (default `300`, set `0` to disable TTL refresh)

Schema metadata is cached in memory and automatically refreshed when the datasets
config file changes on disk or when the TTL elapses. Use the TTL env var to tune
refresh cadence for your deployment.

Optional `.env` in the working directory is also loaded.

## Try Huey with this backend (remote datasource)

See [Try the remote feature](../docs/try-remote-feature.md): start this server, serve Huey, add a remote datasource in the browser console, then explore and run queries.
