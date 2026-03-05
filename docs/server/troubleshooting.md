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

## Cache Troubleshooting

### Stale results after data update

**Symptom:** Query returns old data after the underlying dataset was updated.

**Cause:** Cached entries are served until their TTL expires. The cache key includes a config-file token (path + mtime), so adding/changing `datasets.yaml` automatically invalidates all entries. However, in-place data changes (new parquet files, updated rows) are not auto-detected.

**Resolution:**
- Reduce `QUERYSERVICE_CACHE_TTL_SECONDS` to match your data refresh cadence.
- Restart the service to flush the L1 in-memory cache entirely.
- If SQLite L2 is enabled, delete or reset `QUERYSERVICE_CACHE_SQLITE_PATH` to flush L2 as well.
- For automation, set a short TTL (e.g., 30–60 s) close to your data delivery frequency.

### High miss rate / cache not helping

**Symptom:** Logs consistently show `cache_status=miss` or `cache_status=bypass` even for repeated queries.

**Common causes and resolutions:**

| Cause | How to identify | Resolution |
|---|---|---|
| Cache disabled | `cache_status=disabled` in logs | Set `QUERYSERVICE_CACHE_ENABLED=true` |
| TTL too short | Misses appear after a few seconds | Increase `QUERYSERVICE_CACHE_TTL_SECONDS` |
| Items too large for L1 | `cache_status=bypass` in logs | Increase `QUERYSERVICE_CACHE_MAX_ITEM_BYTES` or `QUERYSERVICE_CACHE_MAX_BYTES` |
| Admission threshold too high | Fast queries never cached | Lower `QUERYSERVICE_CACHE_ADMISSION_MIN_DURATION_MS` |
| Query parameters always vary | Each request has a unique payload | Check that clients reuse identical date ranges and query payloads |
| L1 too small, no L2 configured | High evictions in stats | Add `QUERYSERVICE_CACHE_SQLITE_PATH` for L2 spillover |

**Inspect cache stats** by enabling `DEBUG` logging or instrumenting the `cache.stats()` method. Key counters to watch:
- `hits` / `misses` — overall L1 hit rate
- `evictions` — L1 pressure; increase `QUERYSERVICE_CACHE_MAX_BYTES` if high
- `l2_hits` / `l2_misses` — L2 effectiveness (requires SQLite L2 to be configured)
- `l2_evictions` — L2 pressure; increase `QUERYSERVICE_CACHE_SQLITE_MAX_BYTES` if high
- `endpoint_tuples_hits` / `endpoint_cells_hits` / `endpoint_picklist_hits` — per-endpoint hit rate

### Memory pressure from cache

**Symptom:** Process RSS grows to an unexpected level or OOM kill occurs.

**Resolution:**
- Reduce `QUERYSERVICE_CACHE_MAX_BYTES` (L1 budget).
- Reduce `QUERYSERVICE_CACHE_MAX_ITEM_BYTES` to exclude large result sets.
- Increase `QUERYSERVICE_CACHE_ADMISSION_MIN_DURATION_MS` to only cache expensive queries (e.g., set to `100` to skip sub-100 ms queries).
- Move large items to L2 only by keeping `QUERYSERVICE_CACHE_MAX_ITEM_BYTES` small while providing a larger `QUERYSERVICE_CACHE_SQLITE_MAX_BYTES`.
- See the **Very low memory** preset in the [README tuning presets section](./README.md#query-cache-tuning-presets).

### L2 SQLite cache not being used

**Symptom:** `l2_hits` stays at 0, or `l2.db` file is never created.

**Resolution:**
- Confirm `QUERYSERVICE_CACHE_SQLITE_PATH` is set and the directory is writable.
- Items must first be admitted to L1 before being written to L2; verify that `l2_misses` is incrementing (L2 is being checked but the entry isn't there yet on first access).
- Check that `QUERYSERVICE_CACHE_SQLITE_MAX_BYTES` is large enough to hold the items being cached.

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

Run cache-specific tests:

```bash
./.venv-server/bin/pytest server/tests/test_cache.py server/tests/test_cache_sqlite.py server/tests/test_query_cache_api.py -q
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
