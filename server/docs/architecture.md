# QueryService Architecture

## System overview

QueryService is the Huey backend that serves analytical queries over DuckDB via FastAPI. It owns the HTTP API consumed by the frontend, handles schema-aware validation, builds SQL, executes against DuckDB, and exposes an export pipeline for CSV downloads. The frontend talks only to this service; data storage lives in DuckDB (in-memory or file-backed) and the export job state lives in SQLite.

## Component diagram

- **Routers** (`server/routers/*`) → deserialize/validate requests → call domain services.
- **Query builder** (`server/query_builder.py`) → converts validated bodies into parameterized SQL.
- **Engine** (`server/engine.py`) → manages the shared DuckDB connection → executes SQL.
- **DuckDB** → stores seeded sample tables or user-provided data.

Exports follow a sibling path:

- **Routers** → **Export service** (`server/export_service.py`) → **Export store** (`server/export_store.py`) → SQLite for durable job state and filesystem for CSV outputs.

## Request lifecycle

1. **Middleware**: `CorrelationIdMiddleware` sets/propagates `X-Request-ID` via `contextvars`; `AccessLogMiddleware` times the call and emits a structured log entry.
2. **Routing**: FastAPI routes parse the JSON body into Pydantic models defined in `server/models.py`.
3. **Schema validation**: Inputs are constrained by model fields (e.g., date formats, paging caps) and by dataset schema lookups from `server/datasets.py`.
4. **SQL generation**: Routers call query builder helpers to produce parameterized SQL using double-quoted identifiers and placeholders for values.
5. **Execution**: `DuckDBManager` runs the SQL on the shared connection (async handlers offload to a thread pool).
6. **Response shaping**: Results are mapped back into response models and returned with correlation IDs preserved in headers and logs.

## Data flow

- **Dataset configuration**: YAML at `datasets_config/datasets.yaml` (override via `QUERYSERVICE_DATASETS_CONFIG_PATH`) lists datasets and field metadata. The schema guards allowed fields in query builder and validation.
- **Sample data**: On startup `datasets.load_sample_data` seeds deterministic rows into DuckDB tables when `QUERYSERVICE_SEED_SAMPLE_DATA` is true (default is false; opt-in).
- **Validation linkage**: The schema-derived field names drive filter/axis allowlists so only configured fields become SQL identifiers.

## Export system

- **Lifecycle**: `POST /api/v1/exports` creates a pending job in the SQLite-backed `ExportJobStore`, enforces `export_max_concurrent`, and schedules background processing. Status moves `pending → processing → complete/failed → expired`.
- **Processing**: `ExportService.process` runs the export query, writes CSV to `export_output_dir`, and updates the job record with download URL and row count.
- **Store**: `ExportJobStore` persists job metadata in SQLite (`export_db_path`), using WAL mode for file-backed DBs.
- **TTL cleanup**: `cleanup_expired` removes jobs older than `export_ttl_seconds` and deletes their files.
- **Crash recovery**: On startup `recover_stale_jobs` marks any lingering `processing` jobs as `failed` to avoid hanging states.
- **Background work**: FastAPI `BackgroundTasks` executes exports asynchronously so HTTP responses return immediately.

## Error handling

- Domain errors subclass `AppError` and carry HTTP status codes. Routers raise `DatasetNotFoundError`, `ExportNotFoundError`, `ExportNotReadyError`, `ExportFileNotFoundError`, and `TooManyConcurrentExportsError` when appropriate.
- `ErrorResponse` is the uniform envelope: `{code, message, request_id?, details?}`.
- Global exception handlers translate `AppError`, FastAPI validation errors, and unexpected exceptions into structured JSON responses.

## Configuration

Environment variables (all prefixed `QUERYSERVICE_`, defaults shown):

- `QUERYSERVICE_HOST` (`0.0.0.0`)
- `QUERYSERVICE_PORT` (`8000`)
- `QUERYSERVICE_LOG_LEVEL` (`INFO`)
- `QUERYSERVICE_LOG_FORMAT` (`text`, or `json`)
- `QUERYSERVICE_CORS_ORIGINS` (`[]`, comma-separated list or JSON array)
- `QUERYSERVICE_DATASETS_CONFIG_PATH` (`None`, falls back to bundled YAML)
- `QUERYSERVICE_SEED_SAMPLE_DATA` (`false`)
- `QUERYSERVICE_DATA_DIR` (`None`, DuckDB in-memory; set path for file-backed DB)
- `QUERYSERVICE_EXPORT_TTL_SECONDS` (`3600`)
- `QUERYSERVICE_EXPORT_MAX_CONCURRENT` (`5`)
- `QUERYSERVICE_EXPORT_OUTPUT_DIR` (`/tmp/huey-exports`)
- `QUERYSERVICE_EXPORT_DB_PATH` (`/tmp/huey-exports/jobs.db`)
- `QUERYSERVICE_S3_BUCKET` (`None`)
- `QUERYSERVICE_S3_REGION` (`None`)
- `QUERYSERVICE_EXECUTION_MODE` (`sample_table`; set `parquet_partitioned` for partition-native parquet scans)
- `QUERYSERVICE_PARTITION_BASE_PATH` (`None`; filesystem base for partitions when not using S3)

## Observability

- **Structured logging**: Configurable text/JSON via `logging_config.setup_logging`; logs include `request_id`.
- **Correlation IDs**: Generated or accepted from `X-Request-ID`, stored in `contextvars`, propagated to responses and logs.
- **Access logs**: `AccessLogMiddleware` records method/path/status/duration for every request.
- **Timing**: Query routers log execution durations and row counts for tuples, cells, picklist, and export processing.

## Security considerations

- **SQL injection prevention**: Query builder parameterizes all values and double-quotes identifiers via `quote_identifier`.
- **Schema-based validation**: Fields and filters are validated against configured schemas; date formats and paging are constrained by Pydantic validators.
- **Aggregation allowlist**: Measure aggregations accept a fixed set (`SUM`, `COUNT`, `AVG`, `MIN`, `MAX`).
