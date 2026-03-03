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
- `GET /export/{export_id}/download` – download completed export artifact
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
docker run -p 8000:8000 -e UVICORN_WORKERS=1 query-service
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
- `QUERYSERVICE_DUCKDB_THREADS` (default auto, conservative: `min(4, CPU/worker)`)
- `QUERYSERVICE_DUCKDB_MEMORY_LIMIT` (default unset, DuckDB default)
- `QUERYSERVICE_DUCKDB_TEMP_DIRECTORY` (default `/tmp/huey-duckdb-tmp`)
- `QUERYSERVICE_DUCKDB_ENABLE_OBJECT_CACHE` (default `true`)
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

## Runtime Tuning Profile

QueryService applies DuckDB runtime settings at startup and logs the effective
values (`threads`, `memory_limit`, `temp_directory`, `enable_object_cache`).

Recommended baseline profiles:

- `dev`:
  - `UVICORN_WORKERS=1`
  - `QUERYSERVICE_DUCKDB_THREADS` unset (auto)
  - `QUERYSERVICE_DUCKDB_MEMORY_LIMIT=2GB`
- `staging`:
  - `UVICORN_WORKERS=1`
  - `QUERYSERVICE_DUCKDB_THREADS=4` (or unset for auto)
  - `QUERYSERVICE_DUCKDB_MEMORY_LIMIT=8GB`
- `prod` (large analytical workloads):
  - Start with `UVICORN_WORKERS=1` to avoid CPU oversubscription.
  - Scale workers only when needed for mixed/short queries.
  - If `UVICORN_WORKERS>1`, reduce `QUERYSERVICE_DUCKDB_THREADS` per worker so total threads do not exceed available vCPUs.

Resource sizing baseline:

- CPU: keep total `workers * duckdb_threads <= vCPU count`
- Memory: reserve headroom for app and OS (`duckdb_memory_limit` set with explicit units, e.g. `8GB`)
- Disk: place `duckdb_temp_directory` on fast local SSD for spill-heavy queries

## Try Huey with this backend (remote datasource)

See [Try the remote feature](../docs/try-remote-feature.md): start this server, serve Huey, add a remote datasource in the browser console, then explore and run queries.
