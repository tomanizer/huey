# QueryService API Reference

Base URL examples:

- Local: `http://localhost:8000`
- Containerized (mapped): `http://<host>:8000`

Interactive OpenAPI:

- `/api/v1/docs`
- `/api/v1/redoc`
- `/api/v1/openapi.json`

## Conventions

### Authentication

- Protected endpoints require `X-API-Key` only when `QUERYSERVICE_AUTH_ENABLED=true`.
- Health endpoints do not require API key.

### Request metadata headers

- `X-Request-ID` is accepted and echoed in response headers.
- `X-Client-Version` is accepted on query/export requests and recorded in server logs.
- Error envelopes usually include `request_id` when available.

### Standard response headers

- `X-API-Version: 1` is returned on API responses.
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` are returned when rate limiting is enabled for the endpoint.
- `Retry-After` is returned on `429` responses.

### Shared request envelope (query/export)

```json
{
  "dataset_id": "trades_v1",
  "date_range": {"type": "single", "date": "2026-03-01"},
  "query": {}
}
```

`date_range` schema:

- Single day: `{"type": "single", "date": "YYYY-MM-DD"}`
- Inclusive range: `{"type": "range", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}`

`date_range` behavior by dataset:

- If dataset source defines a time filter column, `date_range` is applied to that column.
- If dataset source has no time filter, `date_range` is accepted but ignored.

### Common error envelope

```json
{
  "code": "DATASET_NOT_FOUND",
  "message": "Dataset not found: trades_v1",
  "request_id": "trace-123",
  "details": {"dataset_id": "trades_v1"}
}
```

## Endpoints

## `GET /health/liveness`

Process liveness probe.

Authentication: not required.

Response `200`:

```json
{"status": "ok"}
```

## `GET /health/readiness`

Readiness probe (checks DuckDB health).

Authentication: not required.

Responses:

- `200`:

```json
{"status": "ok"}
```

- `503`:

```json
{"status": "unavailable"}
```

## `GET /api/v1/datasets/{dataset_id}/schema`

Returns schema metadata for a configured dataset.

Authentication: conditional API key.

Path parameters:

- `dataset_id` (required, string)

Example:

```bash
curl 'http://localhost:8000/api/v1/datasets/trades_v1/schema'
```

Success `200` example:

```json
{
  "dataset_id": "trades_v1",
  "fields": [
    {"name": "date", "type": "date", "is_dimension": true},
    {"name": "symbol", "type": "string", "is_dimension": true},
    {"name": "volume", "type": "int64", "is_measure": true}
  ]
}
```

Error statuses:

- `404` `DATASET_NOT_FOUND`
- `401` auth failure when auth enabled

## `POST /api/v1/datasets/{dataset_id}/query/tuples`

Returns distinct tuple values for selected fields.

Authentication: conditional API key.

Request body fields:

- `dataset_id` (string, required)
- `date_range` (required)
- `query.fields` (array of objects):
  - `field` (string, required)
  - `sort` (`ASC` or `DESC`, optional)
  - `derivation` (optional)
  - `include_totals` (optional)
- `query.filters` (optional):
  - `field` (string)
  - `operator` (`INCLUDE`, `EXCLUDE`, `LIKE`, `BETWEEN`)
  - `values` (array)
- `query.paging` (optional):
  - `limit` (`1..10000`, default from config)
  - `offset` (`>=0`)

Request example:

```json
{
  "dataset_id": "trades_v1",
  "date_range": {"type": "single", "date": "2026-03-01"},
  "query": {
    "fields": [{"field": "symbol", "sort": "ASC"}],
    "filters": [{"field": "symbol", "operator": "INCLUDE", "values": ["AAPL", "GOOG"]}],
    "paging": {"limit": 10, "offset": 0}
  }
}
```

Success `200` example:

```json
{
  "total_count": 2,
  "items": [{"values": ["AAPL"]}, {"values": ["GOOG"]}],
  "paging": {"limit": 10, "offset": 0, "returned": 2}
}
```

Error statuses:

- `404` `DATASET_NOT_FOUND`
- `409` `DATASET_UNAVAILABLE`
- `422` `VALIDATION_ERROR`
- `401` auth failure when auth enabled
- `429` if rate limiting enabled and exceeded

## `POST /api/v1/datasets/{dataset_id}/query/cells`

Returns aggregated cells grouped by row/column axes.

Authentication: conditional API key.

Request body fields:

- `dataset_id` (string, required)
- `date_range` (required)
- `query.axes.rows` (array of `{ "field": string }`)
- `query.axes.columns` (array of `{ "field": string }`)
- `query.axes.measures` (array):
  - `field` (string)
  - `aggregation` (`SUM`, `COUNT`, `AVG`, `MIN`, `MAX`)
  - `alias` (string, optional)
- `query.rows` and `query.columns` windows (optional):
  - `start_index` (`>=0`)
  - `count` (`>=1`)
- `query.filters` (optional)

Request example:

```json
{
  "dataset_id": "trades_v1",
  "date_range": {"type": "single", "date": "2026-03-01"},
  "query": {
    "rows": {"start_index": 0, "count": 10},
    "axes": {
      "rows": [{"field": "symbol"}],
      "columns": [],
      "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_volume"}]
    }
  }
}
```

Success `200` example:

```json
{
  "cells": [
    {"row_index": 0, "values": {"0": "AAPL", "1": 1500}},
    {"row_index": 1, "values": {"0": "GOOG", "1": 2200}}
  ]
}
```

Error statuses:

- `400` `CELLS_WINDOW_TOO_LARGE`
- `404` `DATASET_NOT_FOUND`
- `409` `DATASET_UNAVAILABLE`
- `422` `VALIDATION_ERROR`
- `401` auth failure when auth enabled
- `429` if rate limiting enabled and exceeded

## `POST /api/v1/datasets/{dataset_id}/query/picklist`

Returns distinct values for one field, typically used for filter UIs.

Authentication: conditional API key.

Request body fields:

- `dataset_id` (string, required)
- `date_range` (required)
- `query.field` (string)
- `query.search` (string, optional; `*` is translated to SQL `%` wildcard)
- `query.filters` (optional)
- `query.paging` (optional)

Request example:

```json
{
  "dataset_id": "trades_v1",
  "date_range": {"type": "range", "start": "2026-03-01", "end": "2026-03-02"},
  "query": {
    "field": "symbol",
    "search": "A*",
    "paging": {"limit": 10, "offset": 0}
  }
}
```

Success `200` example:

```json
{
  "total_count": 2,
  "values": [{"value": "AAPL", "label": "AAPL"}, {"value": "AMZN", "label": "AMZN"}],
  "paging": {"limit": 10, "offset": 0, "returned": 2}
}
```

Error statuses:

- `404` `DATASET_NOT_FOUND`
- `409` `DATASET_UNAVAILABLE`
- `422` `VALIDATION_ERROR`
- `401` auth failure when auth enabled
- `429` if rate limiting enabled and exceeded

## `POST /api/v1/exports`

Submits async export job and returns job id immediately.

Authentication: conditional API key.

Request body fields:

- `dataset_id` (string, required)
- `date_range` (required)
- `query.axes` (optional; rows/columns/measures)
- `query.filters` (optional)
- `query.max_rows` (`1..100000`, default `10000`)
- `query.format` (`parquet` or `csv`, default `parquet`)

Request example:

```json
{
  "dataset_id": "trades_v1",
  "date_range": {"type": "single", "date": "2026-03-01"},
  "query": {
    "axes": {
      "rows": [{"field": "symbol"}],
      "measures": [{"field": "volume", "aggregation": "SUM", "alias": "total_volume"}]
    },
    "max_rows": 1000,
    "format": "parquet"
  }
}
```

Success `200` example:

```json
{"export_id": "exp-1234abcd", "status": "pending"}
```

Error statuses:

- `404` `DATASET_NOT_FOUND`
- `409` `DATASET_UNAVAILABLE`
- `429` `TOO_MANY_EXPORTS`
- `422` `VALIDATION_ERROR`
- `401` auth failure when auth enabled
- `429` if rate limiting enabled and exceeded

## `GET /api/v1/exports/{export_id}`

Returns export job status.

Authentication: conditional API key.

Path parameters:

- `export_id` (string)

Success `200` example:

```json
{
  "export_id": "exp-1234abcd",
  "status": "complete",
  "download_url": "/api/v1/exports/exp-1234abcd/download"
}
```

Other statuses include `pending`, `processing`, `failed`, `expired`.

Error statuses:

- `404` `EXPORT_NOT_FOUND`
- `401` auth failure when auth enabled

## `GET /api/v1/exports/{export_id}/download`

Downloads completed export artifact.

Authentication: conditional API key.

Path parameters:

- `export_id` (string)

Success `200`:

- For parquet export: binary file, `Content-Disposition: attachment; filename="<id>.parquet"`
- For csv export: text/csv, `Content-Disposition: attachment; filename="<id>.csv"`

Error statuses:

- `404` `EXPORT_NOT_FOUND`
- `409` `EXPORT_NOT_READY`
- `404` `EXPORT_FILE_NOT_FOUND`
- `401` auth failure when auth enabled

## Pagination, Filtering, and Sorting Summary

- Pagination:
  - `query.paging.limit` and `query.paging.offset` on tuples/picklist
  - Defaults: `tuples_default_limit`, `picklist_default_limit`
- Filtering operators:
  - `INCLUDE`, `EXCLUDE`, `LIKE`, `BETWEEN`
- Sorting:
  - `query.fields[].sort` on tuples (`ASC`/`DESC`)
- Cells windows:
  - `query.rows`/`query.columns` with `start_index` and `count`
  - Limited by `max_axis_cardinality` and `max_cells_per_response`

## Rate Limits and Throttling

- Disabled by default (`QUERYSERVICE_RATE_LIMIT_ENABLED=false`)
- Query endpoints use `QUERYSERVICE_RATE_LIMIT_QUERY`
- Export submission uses `QUERYSERVICE_RATE_LIMIT_EXPORT`
- Exceeded limits return `429`; clients should honor `Retry-After`
