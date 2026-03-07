#!/usr/bin/env python3
"""Generate deterministic parquet test fixtures for Huey.

Run from repo root:
    python tests/fixtures/parquet/generate.py

All files are written next to this script. The generator is deterministic
(seeded RNG) so re-running produces identical output.
"""

import datetime
import math
import os
import random
import shutil

import pyarrow as pa
import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))
RNG = random.Random(42)

SYMBOLS = ["AAPL", "GOOG", "MSFT", "AMZN", "TSLA", "META", "NVDA", "JPM", "BAC", "WFC"]
EXCHANGES = ["NYSE", "NASDAQ", "LSE", "TSE"]
SECTORS = ["Technology", "Finance", "Healthcare", "Energy", "Consumer"]


def _dates(start, n):
    """Return n consecutive dates starting from start (YYYY-MM-DD str)."""
    base = datetime.date.fromisoformat(start)
    return [base + datetime.timedelta(days=i) for i in range(n)]


# ---------------------------------------------------------------------------
# 1. alltypes.parquet — one file, many column types, ~20 rows
# ---------------------------------------------------------------------------
def gen_alltypes():
    n = 20
    dates = _dates("2026-01-01", n)
    table = pa.table({
        "id": pa.array(list(range(1, n + 1)), type=pa.int32()),
        "name": pa.array([RNG.choice(SYMBOLS) for _ in range(n)], type=pa.string()),
        "price": pa.array([round(RNG.uniform(50, 500), 4) for _ in range(n)], type=pa.float64()),
        "quantity": pa.array([RNG.randint(100, 50000) for _ in range(n)], type=pa.int64()),
        "is_active": pa.array([RNG.choice([True, False]) for _ in range(n)], type=pa.bool_()),
        "trade_date": pa.array(dates, type=pa.date32()),
        "created_at": pa.array(
            [datetime.datetime(d.year, d.month, d.day, RNG.randint(9, 16), RNG.randint(0, 59), RNG.randint(0, 59))
             for d in dates],
            type=pa.timestamp("us"),
        ),
        "tags": pa.array(
            [RNG.choice(["buy,hold", "sell", "watch", "dividend,reinvest", ""]) for _ in range(n)],
            type=pa.string(),
        ),
    })
    pq.write_table(table, os.path.join(HERE, "alltypes.parquet"))
    print(f"  alltypes.parquet: {n} rows x {table.num_columns} cols")


# ---------------------------------------------------------------------------
# 2. wide.parquet — 100 columns, 10 rows
# ---------------------------------------------------------------------------
def gen_wide():
    n = 10
    cols = {}
    cols["id"] = pa.array(list(range(1, n + 1)), type=pa.int32())
    cols["symbol"] = pa.array([RNG.choice(SYMBOLS) for _ in range(n)], type=pa.string())
    cols["trade_date"] = pa.array(_dates("2026-01-01", n), type=pa.date32())
    # Fill remaining columns with numeric metrics
    for i in range(97):
        col_name = f"metric_{i:03d}"
        cols[col_name] = pa.array([round(RNG.gauss(100, 30), 2) for _ in range(n)], type=pa.float64())
    table = pa.table(cols)
    pq.write_table(table, os.path.join(HERE, "wide.parquet"))
    print(f"  wide.parquet: {n} rows x {table.num_columns} cols")


# ---------------------------------------------------------------------------
# 3. long.parquet — 3 cols, 500k rows
# ---------------------------------------------------------------------------
def gen_long():
    n = 500_000
    base_date = datetime.date(2020, 1, 1)
    # Pre-generate in chunks to keep memory reasonable
    chunk_size = 50_000
    writer = None
    schema = pa.schema([
        ("trade_date", pa.date32()),
        ("symbol", pa.string()),
        ("price", pa.float64()),
    ])
    path = os.path.join(HERE, "long.parquet")
    for chunk_start in range(0, n, chunk_size):
        chunk_n = min(chunk_size, n - chunk_start)
        batch = pa.record_batch(
            [
                pa.array([base_date + datetime.timedelta(days=(chunk_start + i) // len(SYMBOLS))
                          for i in range(chunk_n)], type=pa.date32()),
                pa.array([SYMBOLS[(chunk_start + i) % len(SYMBOLS)] for i in range(chunk_n)], type=pa.string()),
                pa.array([round(50 + 30 * math.sin((chunk_start + i) * 0.001) + RNG.gauss(0, 5), 2)
                          for i in range(chunk_n)], type=pa.float64()),
            ],
            schema=schema,
        )
        if writer is None:
            writer = pq.ParquetWriter(path, schema)
        writer.write_batch(batch)
    if writer:
        writer.close()
    print(f"  long.parquet: {n} rows x 3 cols")


# ---------------------------------------------------------------------------
# 4. nulls.parquet — various null patterns
# ---------------------------------------------------------------------------
def gen_nulls():
    n = 30
    table = pa.table({
        # No nulls (control column)
        "id": pa.array(list(range(1, n + 1)), type=pa.int32()),
        # Sparse nulls (~20%)
        "price": pa.array(
            [round(RNG.uniform(100, 300), 2) if RNG.random() > 0.2 else None for _ in range(n)],
            type=pa.float64(),
        ),
        # All-null column
        "empty_col": pa.array([None] * n, type=pa.string()),
        # Null only in first row
        "symbol": pa.array(
            [None] + [RNG.choice(SYMBOLS) for _ in range(n - 1)],
            type=pa.string(),
        ),
        # Null only in last row
        "quantity": pa.array(
            [RNG.randint(100, 9999) for _ in range(n - 1)] + [None],
            type=pa.int64(),
        ),
        # Boolean with nulls
        "is_valid": pa.array(
            [RNG.choice([True, False, None]) for _ in range(n)],
            type=pa.bool_(),
        ),
    })
    pq.write_table(table, os.path.join(HERE, "nulls.parquet"))
    print(f"  nulls.parquet: {n} rows x {table.num_columns} cols")


# ---------------------------------------------------------------------------
# 5. single_row.parquet — edge case: 1 row
# ---------------------------------------------------------------------------
def gen_single_row():
    table = pa.table({
        "id": pa.array([1], type=pa.int32()),
        "symbol": pa.array(["AAPL"], type=pa.string()),
        "price": pa.array([150.25], type=pa.float64()),
        "trade_date": pa.array([datetime.date(2026, 1, 1)], type=pa.date32()),
    })
    pq.write_table(table, os.path.join(HERE, "single_row.parquet"))
    print(f"  single_row.parquet: 1 row x {table.num_columns} cols")


# ---------------------------------------------------------------------------
# 6. unicode.parquet — strings with special characters
# ---------------------------------------------------------------------------
def gen_unicode():
    names = [
        "Acme Corp",
        "Zurich Re",
        "Tokyo " + "\u6771\u4eac",
        "S\u00e3o Paulo",
        "Dubai " + "\u062f\u0628\u064a",
        "Caf\u00e9 Holdings",
        "100% Growth Ltd",
        "O'Brien & Co",
        "Null-Island",
        "Tab\there",
        "New\nLine Inc",
        "\U0001f4c8 TrendUp",
        "   Spaces   ",
        "",
        "DROP TABLE;--",
    ]
    n = len(names)
    table = pa.table({
        "id": pa.array(list(range(1, n + 1)), type=pa.int32()),
        "company": pa.array(names, type=pa.string()),
        "revenue": pa.array([round(RNG.uniform(1e6, 1e9), 2) for _ in range(n)], type=pa.float64()),
    })
    pq.write_table(table, os.path.join(HERE, "unicode.parquet"))
    print(f"  unicode.parquet: {n} rows x {table.num_columns} cols")


# ---------------------------------------------------------------------------
# 7. flat_folder/ — 3 parquet files, same schema, no partitioning
# ---------------------------------------------------------------------------
def gen_flat_folder():
    folder = os.path.join(HERE, "flat_folder")
    os.makedirs(folder, exist_ok=True)
    schema = pa.schema([
        ("trade_date", pa.date32()),
        ("symbol", pa.string()),
        ("price", pa.float64()),
        ("volume", pa.int64()),
    ])
    for idx, batch_label in enumerate(["batch_a", "batch_b", "batch_c"]):
        n = 50
        dates = _dates("2026-01-01", n)
        table = pa.table({
            "trade_date": pa.array(dates, type=pa.date32()),
            "symbol": pa.array([SYMBOLS[(idx * 3 + i) % len(SYMBOLS)] for i in range(n)], type=pa.string()),
            "price": pa.array([round(RNG.uniform(80, 400), 2) for _ in range(n)], type=pa.float64()),
            "volume": pa.array([RNG.randint(1000, 100000) for _ in range(n)], type=pa.int64()),
        }, schema=schema)
        pq.write_table(table, os.path.join(folder, f"{batch_label}.parquet"))
    print(f"  flat_folder/: 3 files x 50 rows each")


# ---------------------------------------------------------------------------
# 8. hive_single/ — single-level hive partitioning (partition_date=YYYY-MM-DD/)
# ---------------------------------------------------------------------------
def gen_hive_single():
    folder = os.path.join(HERE, "hive_single")
    if os.path.exists(folder):
        shutil.rmtree(folder)
    dates = _dates("2026-01-01", 4)
    for d in dates:
        part_dir = os.path.join(folder, f"partition_date={d.isoformat()}")
        os.makedirs(part_dir, exist_ok=True)
        n = 20
        table = pa.table({
            "symbol": pa.array([SYMBOLS[i % len(SYMBOLS)] for i in range(n)], type=pa.string()),
            "price": pa.array([round(RNG.uniform(80, 400), 2) for _ in range(n)], type=pa.float64()),
            "volume": pa.array([RNG.randint(1000, 100000) for _ in range(n)], type=pa.int64()),
        })
        pq.write_table(table, os.path.join(part_dir, "data.parquet"))
    print(f"  hive_single/: {len(dates)} partitions x 20 rows each (partition_date=...)")


# ---------------------------------------------------------------------------
# 9. hive_multi/ — multi-level hive partitioning
#    (exchange=.../sector=.../data.parquet)
# ---------------------------------------------------------------------------
def gen_hive_multi():
    folder = os.path.join(HERE, "hive_multi")
    if os.path.exists(folder):
        shutil.rmtree(folder)
    for exchange in EXCHANGES[:3]:
        for sector in SECTORS[:2]:
            part_dir = os.path.join(folder, f"exchange={exchange}", f"sector={sector}")
            os.makedirs(part_dir, exist_ok=True)
            n = 15
            dates = _dates("2026-01-01", n)
            table = pa.table({
                "trade_date": pa.array(dates, type=pa.date32()),
                "symbol": pa.array([RNG.choice(SYMBOLS) for _ in range(n)], type=pa.string()),
                "price": pa.array([round(RNG.uniform(80, 400), 2) for _ in range(n)], type=pa.float64()),
                "volume": pa.array([RNG.randint(1000, 100000) for _ in range(n)], type=pa.int64()),
            })
            pq.write_table(table, os.path.join(part_dir, "data.parquet"))
    combos = 3 * 2
    print(f"  hive_multi/: {combos} partitions x 15 rows each (exchange=.../sector=...)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print("Generating parquet test fixtures...")
    gen_alltypes()
    gen_wide()
    gen_long()
    gen_nulls()
    gen_single_row()
    gen_unicode()
    gen_flat_folder()
    gen_hive_single()
    gen_hive_multi()
    print("Done.")


if __name__ == "__main__":
    main()
