# QueryService Troubleshooting and FAQ

## Quick Checks

1. Is the service up?

```bash
curl -i http://localhost:8000/health/liveness
curl -i http://localhost:8000/health/readiness
```

2. Are settings loaded as expected?

- Confirm `.env` location and active shell environment.
- Confirm `QUERYSERVICE_*` names are exact.

3. Is dataset configuration loaded?

- Verify `QUERYSERVICE_DATASETS_CONFIG_PATH` if overriding defaults.
- Validate YAML format and dataset IDs.

## Common Issues

| Symptom | Likely cause | Resolution |
|---|---|---|
| `404 DATASET_NOT_FOUND` | Unknown `dataset_id` in YAML | Add/fix dataset in datasets config, then retry |
| `409 DATASET_UNAVAILABLE` | Dataset exists in config but table/data is not available in DuckDB | Materialize/load table for the dataset, or fix execution mode/path config |
| `422 VALIDATION_ERROR` for dates | Invalid calendar date or format | Use strict `YYYY-MM-DD` real date values |
| `401` on protected endpoint | Auth enabled and missing/invalid API key | Send `X-API-Key` matching `QUERYSERVICE_API_KEYS` |
| `429 TOO_MANY_EXPORTS` | Active exports hit configured cap | Wait for active exports to complete/expire or increase `QUERYSERVICE_EXPORT_MAX_CONCURRENT` |
| Export status stuck at `failed` | Query failed during background export | Inspect logs; validate dataset/table presence and filters |
| `404 EXPORT_FILE_NOT_FOUND` | Job says complete but artifact file missing | Check `QUERYSERVICE_EXPORT_OUTPUT_DIR` persistence and cleanup policies |
| `503` readiness | DuckDB connection unhealthy | Check process logs and DuckDB configuration; restart service if needed |
| CORS browser errors | Origin not allowed | Add origin to `QUERYSERVICE_CORS_ORIGINS` |
| Slow/heavy queries | Thread/memory/temp settings not tuned | Tune DuckDB settings and response window limits |

## Debugging Commands

Run tests (from repo root):

```bash
./.venv-server/bin/pytest server/tests -q
```

Run targeted API contract tests:

```bash
./.venv-server/bin/pytest server/tests/test_error_contract.py -q
```

Run export tests:

```bash
./.venv-server/bin/pytest server/tests/test_export_api.py server/tests/test_export_service.py -q
```

## FAQ

### Does export default to CSV?

No. The default export format is **parquet** when `query.format` is omitted.

### Why do I get `DATASET_UNAVAILABLE` when schema exists?

Schema metadata and physical table availability are separate checks. A dataset can be configured but not materialized/loaded in DuckDB.

### Are all errors returned in the same envelope?

Domain and validation errors use `{code, message, request_id?, details?}`. Auth failures use FastAPI HTTPException shape (`detail`), and rate-limit responses depend on slowapi handler shape.

### Is data persistent by default?

- DuckDB is in-memory unless `QUERYSERVICE_DATA_DIR` is set.
- Export jobs/files are persisted if `QUERYSERVICE_EXPORT_DB_PATH` and `QUERYSERVICE_EXPORT_OUTPUT_DIR` point to persistent storage.

### Is there automatic migration for the export SQLite schema?

No migration framework is currently included. Treat schema changes as manual operational changes.
