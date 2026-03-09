# Frontend performance benchmarks

This document describes the repeatable benchmark workflow for Huey's local-mode frontend performance.

## Goal

Use the same benchmark scenarios before and after frontend optimizations so changes are measured against a stable baseline instead of relying on ad hoc console inspection.

## Runner

Run:

```bash
npm run perf:ui
```

By default this:

- builds the frontend bundle
- starts the local preview server on `http://127.0.0.1:8765`
- runs benchmark scenarios in Chromium
- writes artifacts to `artifacts/ui-benchmarks/latest`

Optional flags:

```bash
node scripts/ui_benchmark_runner.cjs --output-dir artifacts/ui-benchmarks/run-a --baseline benchmarks/ui/baseline_metrics.json
```

## Scenarios

The benchmark runner currently measures:

- `app_ready`: app load to interactive shell
- `upload_wide_schema`: upload `tests/fixtures/parquet/wide.parquet` and wait for schema/attributes
- `long_pivot_first_run`: upload `tests/fixtures/parquet/long.parquet`, build a pivot, and run the first query
- `long_pivot_rerun`: re-run the same pivot to observe cache behavior
- `long_pivot_scroll`: scroll an already-run tall pivot and measure viewport update latency

## Metrics

Each scenario records:

- `wallTimeMs`: end-to-end wall clock time for the scenario
- `uiMetrics.queryTimeMs`: Huey's measured query time when available
- `uiMetrics.renderTimeMs`: Huey's measured render time when available
- `uiMetrics.totalTimeMs`: Huey's measured total time when available
- `sql.count`: number of DuckDB queries logged during the scenario
- `sql.totalTimeMs`: summed DuckDB query time from logged statements
- `sql.byKind`: query counts split into `schema`, `tuples`, `cells`, and `other`

## Artifacts

The runner writes:

- `ui-benchmark-report.json`: full machine-readable report
- `ui-benchmark-report.csv`: tabular metrics for spreadsheet or diff tooling
- `ui-benchmark-summary.md`: human-readable summary with baseline deltas
- `webserver.log`: build/preview server output captured during the run

## Baseline comparison

If `benchmarks/ui/baseline_metrics.json` exists, the runner compares current results against the baseline and reports deltas for:

- wall clock time
- UI total time
- total SQL time

The baseline is intended as a reference point for local development and PR comparisons, not as a hard universal SLO.

## Merge policy for optimization PRs

For frontend performance PRs:

1. Run the benchmark before the optimization.
2. Run it again after the optimization.
3. Attach or summarize the delta in the PR.
4. Do not merge if representative scenarios regress without a clear reason.
