# Backend performance benchmarks

## One-command runner

```bash
python scripts/backend_benchmark_runner.py \
  --base-url http://127.0.0.1:8000 \
  --output-dir artifacts/benchmarks/latest
```

This runs benchmark workloads for:
- `POST /query/tuples`
- `POST /query/cells`
- `POST /query/picklist`
- `POST /export`

Outputs:
- `benchmark-report.json` (machine-readable full report)
- `benchmark-report.csv` (tabular KPIs)
- `benchmark-summary.md` (human summary)

## KPI definitions

- **p50/p95/p99 latency**: request duration percentiles in milliseconds.
- **throughput (rps)**: total requests per endpoint divided by run duration.
- **bytes scanned**: aggregated `x-bytes-scanned` response header when provided.
- **peak RSS**: runner process max resident memory (KB).
- **spill volume**: aggregated `x-spill-bytes` response header when provided.
- **timeout/error rate**: `(timeouts + errors) / total requests`.

Thresholds are configured in `server/benchmarks/thresholds.json`.
Current mode is `warn` to support non-blocking trend tracking.

## Synthetic data guidance (50GB/date target)

1. Start with small fixtures to validate correctness and artifact generation.
2. Scale rows to hit approximately 50GB per date partition while keeping the same field cardinality shape as production.
3. Keep at least one high-cardinality dimension (for tuples/picklist) and one heavy aggregation workload (for cells/export).
4. Run the same benchmark command with fixed `--workers` and `--requests-per-endpoint` for comparable trend lines.

`trades_v1` is the default sample dataset used by existing backend tests. For larger-scale runs, point `--dataset-id` to your synthetic 50GB/date dataset.

## Baseline tracking

- Initial baseline placeholder: `server/benchmarks/baseline_metrics.json`
- Nightly snapshots: workflow artifact `backend-benchmark-artifacts`
