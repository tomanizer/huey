#!/usr/bin/env python3
"""Compare export strategies: dual-scan (COUNT+COPY) vs single-scan (COPY only)."""

import argparse
import tempfile
import time
from pathlib import Path

import duckdb


def _time_call(fn) -> float:
    start = time.perf_counter()
    fn()
    return time.perf_counter() - start


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=2_000_000)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="huey-export-bench-") as tmpdir:
        out_dir = Path(tmpdir)
        conn = duckdb.connect(":memory:")
        conn.execute(
            "CREATE TABLE bench AS SELECT i AS id, i % 100 AS bucket, i * 2 AS value FROM range(?) t(i)",
            [args.rows],
        )
        sql = "SELECT id, bucket, value FROM bench WHERE bucket < 90"

        dual_csv = out_dir / "dual.csv"
        single_csv = out_dir / "single.csv"

        dual_time = _time_call(
            lambda: (
                conn.execute(f"SELECT COUNT(*) FROM ({sql}) x").fetchone(),
                conn.execute(f"COPY ({sql}) TO '{dual_csv}' (FORMAT CSV, HEADER TRUE)"),
            )
        )
        single_time = _time_call(
            lambda: conn.execute(f"COPY ({sql}) TO '{single_csv}' (FORMAT CSV, HEADER TRUE)")
        )

        speedup = (dual_time - single_time) / dual_time * 100 if dual_time else 0.0
        print(f"rows={args.rows}")
        print(f"dual_scan_seconds={dual_time:.4f}")
        print(f"single_scan_seconds={single_time:.4f}")
        print(f"single_scan_improvement_pct={speedup:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
