# QueryService Configuration Reference

All application settings are read from environment variables prefixed with `QUERYSERVICE_`.

Example: `QUERYSERVICE_PORT=8000` maps to `port` setting.

## Core Server

| Variable | Default | Type | Purpose |
|---|---:|---|---|
| `QUERYSERVICE_HOST` | `0.0.0.0` | string | Bind host |
| `QUERYSERVICE_PORT` | `8000` | int | Bind port |
| `QUERYSERVICE_LOG_LEVEL` | `INFO` | string | Log level |
| `QUERYSERVICE_LOG_FORMAT` | `text` | `text` \| `json` | Log output format |
| `QUERYSERVICE_CORS_ORIGINS` | `[]` | CSV or JSON array | Allowed browser origins |

## Dataset and Seeding

| Variable | Default | Type | Purpose |
|---|---:|---|---|
| `QUERYSERVICE_DATASETS_CONFIG_PATH` | bundled `server/datasets_config/datasets.yaml` | string | Override datasets YAML path |
| `QUERYSERVICE_SEED_SAMPLE_DATA` | `false` | bool | Seed sample data tables at startup |
| `QUERYSERVICE_SCHEMA_CACHE_TTL_SECONDS` | `300` | float or empty | Dataset schema cache TTL (`0`/empty disables TTL refresh) |

## DuckDB Runtime

| Variable | Default | Type | Purpose |
|---|---:|---|---|
| `QUERYSERVICE_DATA_DIR` | unset | string | DuckDB DB file path; unset uses in-memory |
| `QUERYSERVICE_DUCKDB_THREADS` | auto (`min(4, cpu/workers)`) | int | DuckDB execution threads |
| `QUERYSERVICE_DUCKDB_MEMORY_LIMIT` | unset | string | DuckDB memory limit (example `8GB`) |
| `QUERYSERVICE_DUCKDB_TEMP_DIRECTORY` | `/tmp/huey-duckdb-tmp` | string | Spill directory |
| `QUERYSERVICE_DUCKDB_ENABLE_OBJECT_CACHE` | `true` | bool | DuckDB object cache toggle |

## Query and Response Limits

| Variable | Default | Type | Purpose |
|---|---:|---|---|
| `QUERYSERVICE_QUERY_TIMEOUT_SECONDS` | `30.0` | float | Query timeout budget setting |
| `QUERYSERVICE_MAX_CONCURRENT_QUERIES` | `8` | int | Concurrent query budget setting |
| `QUERYSERVICE_MAX_QUERY_QUEUE_DEPTH` | `32` | int or empty | Queue depth budget setting |
| `QUERYSERVICE_SHUTDOWN_DRAIN_SECONDS` | `10.0` | float | Max seconds to wait for in-flight queries on graceful shutdown |
| `QUERYSERVICE_TUPLES_DEFAULT_LIMIT` | `200` | int | Default tuples page size |
| `QUERYSERVICE_PICKLIST_DEFAULT_LIMIT` | `100` | int | Default picklist page size |
| `QUERYSERVICE_MAX_CELLS_PER_RESPONSE` | `10000` | int | Max cells payload bound |
| `QUERYSERVICE_MAX_AXIS_CARDINALITY` | `5000` | int | Max axis cardinality/window |

## Authentication and Rate Limiting

| Variable | Default | Type | Purpose |
|---|---:|---|---|
| `QUERYSERVICE_AUTH_ENABLED` | `false` | bool | Require `X-API-Key` on protected endpoints |
| `QUERYSERVICE_API_KEYS` | unset | CSV string | Allowed API keys |
| `QUERYSERVICE_RATE_LIMIT_ENABLED` | `false` | bool | Enable slowapi rate limiting |
| `QUERYSERVICE_RATE_LIMIT_QUERY` | `100/minute` | string | Query endpoint limit policy |
| `QUERYSERVICE_RATE_LIMIT_EXPORT` | `10/minute` | string | Export submission limit policy |

## Export Pipeline

| Variable | Default | Type | Purpose |
|---|---:|---|---|
| `QUERYSERVICE_EXPORT_TTL_SECONDS` | `3600` | int | Expiration TTL for complete/failed exports |
| `QUERYSERVICE_EXPORT_MAX_CONCURRENT` | `5` | int | Max active exports (`pending`/`processing`) |
| `QUERYSERVICE_EXPORT_OUTPUT_DIR` | `/tmp/huey-exports` | string | Export artifact directory |
| `QUERYSERVICE_EXPORT_DB_PATH` | `/tmp/huey-exports/jobs.db` | string | SQLite job store path |

## Query Result Cache

| Variable | Default | Type | Purpose |
|---|---:|---|---|
| `QUERYSERVICE_CACHE_ENABLED` | `false` | bool | Enable query response cache |
| `QUERYSERVICE_CACHE_TTL_SECONDS` | `120` | int | Cache TTL |
| `QUERYSERVICE_CACHE_MAX_BYTES` | `67108864` | int | Max in-memory cache budget (bytes) |
| `QUERYSERVICE_CACHE_MAX_ITEM_BYTES` | `1048576` | int | Max cached item size (bytes) |
| `QUERYSERVICE_CACHE_ADMISSION_MIN_DURATION_MS` | `0.0` | float | Minimum query duration to cache |
| `QUERYSERVICE_CACHE_SQLITE_PATH` | unset | string | Optional SQLite-backed cache path |
| `QUERYSERVICE_CACHE_SQLITE_MAX_BYTES` | `268435456` | int | Max SQLite cache size budget |

## Dimension Dictionary Cache (`/query/picklist`)

Picklist / filter-dropdown queries are backed by a dedicated dimension cache
with a longer default TTL and optional stale-while-revalidate behaviour,
because dimension reference data changes infrequently.

| Variable | Default | Type | Purpose |
|---|---:|---|---|
| `QUERYSERVICE_DIM_CACHE_TTL_SECONDS` | `3600` | int | Fresh TTL for dimension (picklist) results |
| `QUERYSERVICE_DIM_STALE_TTL_SECONDS` | `0` | int | Extra seconds to serve a stale response while a background refresh runs (`0` disables stale-while-revalidate) |
| `QUERYSERVICE_DIM_VERSION_TOKEN` | unset | string | Optional external override for the dimension version token; change this value to force cache invalidation across all fields (useful after a reference-data reload or in multi-node deployments) |
| `QUERYSERVICE_DIM_PREWARM_FIELDS` | unset | string | Comma-separated list of `dataset_id:field_name` pairs to prewarm on startup (e.g. `trades_v1:symbol,trades_v1:region`) |

### How dimension cache invalidation works

Each picklist cache key includes a **`dim_version_token`**.  By default the
token is a short SHA-256 derived from the datasets config file path, its
modification timestamp, and the field definitions for the requested dataset.
The token therefore changes automatically whenever the config file is edited.

Operators can force a global invalidation at any time by setting
`QUERYSERVICE_DIM_VERSION_TOKEN` to a new value without restarting the
service (a live settings refresh is not required – the new value takes effect
on the next request after the environment variable is updated and the process
is restarted, or immediately when the setting is changed in a test/override
context).

### Stale-while-revalidate

When `QUERYSERVICE_DIM_STALE_TTL_SECONDS > 0` a stale dimension result is
returned immediately to the client while a background task fetches a fresh
copy and updates the cache.  The total serving window is
`DIM_CACHE_TTL_SECONDS + DIM_STALE_TTL_SECONDS`.

Example: `DIM_CACHE_TTL_SECONDS=3600 DIM_STALE_TTL_SECONDS=300` means
responses are fresh for 1 hour and stale-but-served for an additional 5
minutes, after which the entry is fully evicted and the next request blocks
on a fresh computation.

### Configurable prewarming

Set `QUERYSERVICE_DIM_PREWARM_FIELDS` to a comma-separated list of
`dataset_id:field_name` pairs.  On startup the server executes one picklist
query per configured field and stores the result in the dimension cache so
the first real client request is served from cache:

```bash
QUERYSERVICE_DIM_PREWARM_FIELDS=trades_v1:symbol,trades_v1:region
```

Prewarming runs as a background task and never blocks or fails the startup
sequence.

## Execution Mode and Partitions

| Variable | Default | Type | Purpose |
|---|---:|---|---|
| `QUERYSERVICE_EXECUTION_MODE` | `sample_table` | `sample_table` \| `parquet_partitioned` | Query relation mode |
| `QUERYSERVICE_PARTITION_BASE_PATH` | unset | string | Local partition root when using partitioned mode |
| `QUERYSERVICE_S3_BUCKET` | unset | string | S3 bucket for partitioned mode |
| `QUERYSERVICE_S3_REGION` | unset | string | S3 region |

## Additional Non-Prefixed Environment Variables

| Variable | Default | Purpose |
|---|---:|---|
| `UVICORN_WORKERS` | `1` | Worker count used at container start and thread auto-tuning heuristic |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | unset | AWS credential chain inputs when using S3 |

## Notes

- Empty strings for optional path/string settings are normalized to `None`.
- `QUERYSERVICE_CORS_ORIGINS` accepts either CSV (`https://a,https://b`) or JSON array (`["https://a","https://b"]`).
- Settings are cached in-process; test code may clear cache with `get_settings.cache_clear()` when mutating environment at runtime.

## Dataset `source` Configuration (YAML)

Datasets may define a per-dataset physical source block in `datasets.yaml` to override the legacy
`<dataset_id>/date=YYYY-MM-DD/*.parquet` convention:

```yaml
datasets:
  - dataset_id: nyc_taxi_yellow
    source:
      kind: parquet_scan
      uris:
        - s3://nyc-tlc/trip data/yellow_tripdata_*.parquet
      read_options:
        hive_partitioning: false   # true | false | auto
        union_by_name: true
        filename: false
      time_filter:
        column: tpep_pickup_datetime
        type: timestamp            # date | timestamp | string
      max_files: 5000
    fields:
      - name: VendorID
        type: int64
        is_dimension: true
```

Behavior:

- If `source` is omitted, QueryService uses legacy partition behavior in `parquet_partitioned` mode.
- If `source.time_filter` is omitted, the API still accepts `date_range` but does not apply a time predicate.
- `read_options.hive_partitioning` supports non-Hive, single-Hive, or multi-Hive layouts.
