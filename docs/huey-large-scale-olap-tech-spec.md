## Huey Large-Scale OLAP – Technical Specification

This specification defines how Huey will integrate with a server-side query service to support large S3-backed parquet datasets (50 GB per day, multi-year history).

### 1. Overview and Scope

The Technical Specification covers:

- A **QueryService** backend API that executes pivot and filter queries against S3 parquet.
- The **query model** and its mapping from Huey’s axes/filters to backend queries.
- Integration between **Huey (client)** and the backend.
- Non-functional behavior (performance, reliability, security, observability).
- Testing expectations.

### 2. Data Model and Partitioning

#### 2.1 Dataset abstraction

- Each “condat” is a logical dataset:
  - `dataset_id`: string ID (for example, `trades_v1`, `events_app_a`).

#### 2.2 Physical layout (example)

- Data stored in S3 (or compatible object store):
  - `s3://<bucket>/<dataset_id>/date=<YYYY-MM-DD>/part-*.parquet`

#### 2.3 Partitioning

- Partition column:
  - `date` (or `dt`): a date (not datetime) used for partitioning.
- All interactive queries must include a date constraint:
  - Single day.
  - Date range (with explicit bounds).

#### 2.4 Schema metadata

- For each dataset:
  - `fields`:
    - `name`: string.
    - `type`: one of `string`, `int64`, `float64`, `bool`, `timestamp`, `date`, etc.
    - `is_dimension`: boolean (optional, default inferred).
    - `is_measure`: boolean (optional).
    - Optional: `description`, `categories`, `group`.

#### 2.5 Schema evolution

- Additive columns:
  - Supported; missing columns on older dates produce `NULL` results.
- Type changes:
  - Must be explicitly marked in metadata.
  - Backend may reject combinations that require incompatible coercions (for example, merging `string` and `int64`).

### 3. Backend API Design

The backend exposes an HTTP/JSON API (gRPC is a possible future extension).

#### 3.1 Common request envelope

All POST endpoints accept a common envelope:

```json
{
  "dataset_id": "trades_v1",
  "date_range": {
    "type": "single",
    "date": "2026-03-01"
  },
  "query": { },
  "client_context": {
    "user_id": "user-123",
    "request_id": "uuid-...",
    "huey_version": "1.0.13"
  }
}
```

`date_range` variants:

- Single day:

```json
{ "type": "single", "date": "2026-03-01" }
```

- Closed range:

```json
{ "type": "range", "start": "2026-03-01", "end": "2026-03-07" }
```

#### 3.2 GET /schema

Fetch schema metadata for a dataset.

- **Request**
  - `GET /schema?dataset_id=trades_v1`
- **Response**

```json
{
  "dataset_id": "trades_v1",
  "fields": [
    { "name": "date", "type": "date", "is_dimension": true },
    { "name": "symbol", "type": "string", "is_dimension": true },
    { "name": "volume", "type": "int64", "is_measure": true }
  ]
}
```

#### 3.3 POST /query/tuples

Fetch **row or column headers** (tuples) for one axis.

- **Request** (body inside envelope `query` field)

```json
{
  "axis": "rows",
  "fields": [
    { "field": "symbol", "derivation": null, "sort": "asc", "include_totals": true }
  ],
  "filters": [
    {
      "field": "region",
      "operator": "in",
      "values": ["EMEA", "APAC"]
    }
  ],
  "paging": {
    "limit": 200,
    "offset": 0
  }
}
```

- **Response**

```json
{
  "total_count": 12345,
  "items": [
    { "values": ["AAPL"], "grouping_id": 0 },
    { "values": ["GOOG"], "grouping_id": 0 }
  ],
  "paging": {
    "limit": 200,
    "offset": 0,
    "returned": 200
  }
}
```

`grouping_id` is used for totals/subtotals when supported by the engine (for example, via `GROUPING_ID`).

#### 3.4 POST /query/cells

Fetch **cell values** for a rectangular window of row and column tuples.

- **Request**

```json
{
  "rows": {
    "start_index": 0,
    "count": 100
  },
  "columns": {
    "start_index": 0,
    "count": 50
  },
  "axes": {
    "rows": [
      { "field": "symbol", "derivation": null }
    ],
    "columns": [
      { "field": "region", "derivation": null }
    ],
    "measures": [
      { "field": "volume", "aggregation": "sum", "alias": "sum_volume" }
    ]
  },
  "filters": [
    {
      "field": "region",
      "operator": "in",
      "values": ["EMEA", "APAC"]
    }
  ]
}
```

- **Response**

```json
{
  "cells": [
    {
      "row_index": 0,
      "column_index": 0,
      "values": {
        "sum_volume": 1234567
      }
    }
  ]
}
```

#### 3.5 POST /query/picklist

Fetch distinct values for a field to populate the filter UI.

- **Request**

```json
{
  "field": "symbol",
  "search": "AA*",
  "filters": [
    {
      "field": "region",
      "operator": "in",
      "values": ["EMEA"]
    }
  ],
  "paging": {
    "limit": 100,
    "offset": 0
  }
}
```

- **Response**

```json
{
  "total_count": 4321,
  "values": [
    { "value": "AAPL", "label": "AAPL" },
    { "value": "AAL",  "label": "AAL"  }
  ],
  "paging": {
    "limit": 100,
    "offset": 0,
    "returned": 100
  }
}
```

The `search` semantics are engine-dependent (for example, translated into `LIKE` or regex).

#### 3.6 POST /export and GET /export/{id}

Export pivot results or underlying rows.

- **Request** (`POST /export`)

```json
{
  "export_type": "pivot_results",
  "axes": {
    "rows": [{ "field": "symbol" }],
    "columns": [{ "field": "region" }],
    "measures": [{ "field": "volume", "aggregation": "sum", "alias": "sum_volume" }]
  },
  "filters": [],
  "max_rows": 1000000,
  "format": "csv"
}
```

- **Response**

```json
{
  "export_id": "exp-123",
  "status": "pending"
}
```

- **Status / download** (`GET /export/{id}`)

```json
{
  "export_id": "exp-123",
  "status": "complete",
  "download_url": "https://.../exp-123.csv?signature=..."
}
```

### 4. Query Model and Translation

#### 4.1 Strategy

There are two approaches:

- **Phase 1**: Huey continues to generate SQL (close to its existing DuckDB-WASM integration). QueryService:
  - Validates SQL for safety (for example, only `SELECT`).
  - Injects mandatory `WHERE date BETWEEN ...` clauses if missing.
  - Executes SQL against the engine and maps results to the tuple/cell APIs.

- **Phase 2**: Huey sends a structured **query model**:
  - `rows`, `columns`, `measures`, `filters`, `date_range`.
  - Backend builds SQL or engine-native plans, enabling:
    - Policy enforcement.
    - Advanced optimizations and caching.

#### 4.2 Filters

Supported filter operators (initial set):

- Equality: `IN`, `NOT IN`.
- Ranges: `BETWEEN`, `NOT BETWEEN`.
- Pattern filters: `LIKE`, `NOT LIKE`.
- Boolean: `= TRUE` / `= FALSE`.

Filter shape:

```json
{
  "field": "region",
  "operator": "in",
  "values": ["EMEA", "APAC"]
}
```

Backend translates filters into `WHERE` clauses, always including date/partition filters for partition pruning.

#### 4.3 Aggregations and totals

- Aggregations:
  - `count`, `sum`, `avg`, `min`, `max`, and optionally percentiles or other advanced aggregates if engine supports them.
- Totals and subtotals:
  - Prefer using `GROUPING SETS` and `GROUPING_ID` (DuckDB-like engines).
  - If not available, backend may:
    - Issue additional queries for totals.
    - Combine totals into response so Huey can render total rows/columns.

#### 4.4 Paging model

- Tuple endpoints use limit/offset (initially, matching Huey).
- Backend should support keyset/cursor pagination later to avoid deep offset scans on very large cardinalities.

### 5. Execution Engine and Storage Integration

#### 5.1 Engine choice

Assume a **columnar analytical engine** with strong support for:

- Parquet reading.
- S3/object store integration.
- Predicate and projection pushdown.
- GROUP BY and aggregation for large datasets.

**Chosen stack:** QueryService is implemented in **Python** with **FastAPI** and **DuckDB** (embedded via the `duckdb` Python package). This aligns with Huey’s DuckDB dialect and keeps a single-process deployment. See the [Architecture](huey-large-scale-olap-architecture.md) doc, “Backend stack” section.

#### 5.2 S3 access

- Configuration:
  - S3 endpoint and region.
  - Credentials (IAM role, instance profile, or explicit keys).
- Performance considerations:
  - Use listing and metadata to discover partitions.
  - Leverage parquet statistics for pruning and column selection.
  - Optional local caching of frequently accessed partitions.

### 6. Performance and Resource Management

- **Time limits**
  - Default maximum query runtime (for example, 60–120 seconds), configurable per environment.

- **Row and size limits**
  - Caps for:
    - Number of tuples returned per `/query/tuples` call.
    - Number of cells returned per `/query/cells` call.
    - Number of rows per export job.

- **Concurrency**
  - Global concurrency limit at the service level.
  - Excess requests either:
    - Queue with backpressure, or
    - Fail fast with a “please retry” status.

- **Caching**
  - Candidate cache targets:
    - Dataset schemas.
    - Partition listings per dataset/date range.
    - Frequently used partitions and common aggregate results (for example, previous day’s summaries).

### 7. Security and Multi-Tenancy

- **Authentication**
  - For example, JWT-based tokens in `Authorization` header.
  - Service validates tokens via organization’s identity provider.

- **Authorization**
  - Policy configuration per dataset:
    - Which user groups can access which datasets.
    - Optional predicate-based restrictions (for example, `region IN (...)`).

- **Auditing**
  - Log for each query:
    - Caller identity.
    - Dataset and date_range.
    - Query shape (for example, a hash of SQL or serialized query model).
    - Timestamp and status (success/failure, duration).

### 8. Client Integration (Huey)

#### 8.1 Remote datasource type

Huey introduces a new **RemoteDatasource** abstraction:

- Configuration:
  - Base API URL.
  - Dataset ID.
  - Auth mode (for example, token injection or cookie).
- Behavior:
  - Use `/schema` to populate attributes/fields.
  - Use `/query/tuples` and `/query/cells` for pivot data.
  - Use `/query/picklist` for filter values.
  - Use `/export` for server-side exports.

Huey should keep its current WASM-based datasource for local/small file usage, selectable per dataset.

#### 8.2 Error handling and UX

- All errors from QueryService are mapped to user-friendly messages.
- Network errors and timeouts are surfaced with suggestions (for example, reduce date range, reduce cardinality).
- Unsupported features (for example, certain aggregations) are disabled or clearly indicated.

### 9. Observability and Operations

- **Metrics**
  - Per-endpoint:
    - QPS, latency (p50, p90, p95, p99).
    - Error and timeout counts.
  - Engine-level:
    - Query runtime distribution.
    - S3 IO metrics.

- **Logging**
  - Structured logs containing:
    - Request IDs.
    - User IDs (or anonymised equivalents).
    - Dataset IDs and date ranges.
    - Summary of query shape.

- **Health**
  - `/health/liveness`: basic “up” check.
  - `/health/readiness`: verifies engine connectivity and S3 access (or a cheaper equivalent).

### 10. Testing Strategy

- **Unit tests**
  - Query model to SQL translation (if backend generates SQL).
  - Filter and aggregation mapping correctness.
  - Pagination logic and cursor/offset behavior.

- **Integration tests**
  - End-to-end flows from simulated Huey calls:
    - `/schema` + `/query/tuples` + `/query/cells`.
    - `/query/picklist` under selective filters.
  - Use synthetic 50 GB-equivalent partitions for realistic performance characteristics.

- **Performance tests**
  - Representative pivot interactions under concurrent user load.
  - Vary date ranges (single day vs. multi-day) and cardinality.

- **Resilience tests**
  - S3 throttling and transient failures.
  - Engine restarts while queries are in flight.
  - QueryService rolling upgrades and failure scenarios.

