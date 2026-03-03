"""
Dataset configuration loader.

Loads dataset and schema metadata from a YAML config file (e.g. dataset_id, fields).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

import yaml

from server.config import get_settings
from server.utils import quote_identifier

if TYPE_CHECKING:
    from server.engine import DuckDBManager

logger = logging.getLogger("query_service.datasets")


def _default_config_path() -> Path:
    """Default path to datasets config (next to this file)."""
    return Path(__file__).resolve().parent / "datasets_config" / "datasets.yaml"


def load_datasets_config() -> dict[str, Any]:
    """
    Load the datasets config from YAML.
    Returns a dict with key 'datasets': list of { dataset_id, fields }.
    """
    settings = get_settings()
    path = settings.datasets_config_path
    if path is None or path == "":
        path = _default_config_path()
    else:
        path = Path(path)

    if not path.exists():
        return {"datasets": []}

    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)

    if not data or not isinstance(data, dict):
        return {"datasets": []}
    if "datasets" not in data or not isinstance(data["datasets"], list):
        return {"datasets": []}
    return data


def get_schema(dataset_id: str) -> Optional[dict[str, Any]]:
    """
    Return schema for a dataset: { dataset_id, fields }.
    Returns None if dataset_id is not found.
    """
    config = load_datasets_config()
    for ds in config.get("datasets", []):
        if isinstance(ds, dict) and ds.get("dataset_id") == dataset_id:
            return {
                "dataset_id": dataset_id,
                "fields": ds.get("fields", []),
            }
    return None


def get_schema_field_names(dataset_id: str) -> set[str]:
    """Return the set of field names defined in the schema for a dataset."""
    schema = get_schema(dataset_id)
    if not schema:
        return set()
    return {f["name"] for f in schema.get("fields", []) if isinstance(f, dict) and "name" in f}


_DUCKDB_TYPE_MAP = {
    "string": "VARCHAR",
    "int64": "BIGINT",
    "float64": "DOUBLE",
    "date": "DATE",
    "boolean": "BOOLEAN",
}

_SAMPLE_VALUES: dict[str, list] = {
    "date": [
        "2026-03-01", "2026-03-01", "2026-03-01", "2026-03-01",
        "2026-03-01", "2026-03-02", "2026-03-02", "2026-03-02",
    ],
    "string": ["AAPL", "GOOG", "MSFT", "AMZN", "TSLA", "AAPL", "GOOG", "MSFT"],
    "int64": [1500, 2200, 1800, 3100, 900, 1600, 2100, 1900],
    "float64": [150.50, 220.30, 180.00, 310.70, 90.20, 160.10, 210.80, 190.40],
    "boolean": [True, False, True, False, True, False, True, False],
}

_NUM_SAMPLE_ROWS = 8


def generate_sample_rows(fields: list[dict[str, Any]]) -> list[tuple]:
    """Generate deterministic sample rows from field type definitions.

    Returns a list of tuples, each matching the column order in *fields*.
    """
    rows: list[tuple] = []
    for i in range(_NUM_SAMPLE_ROWS):
        row: list[Any] = []
        for f in fields:
            ftype = f.get("type", "string")
            pool = _SAMPLE_VALUES.get(ftype, _SAMPLE_VALUES["string"])
            row.append(pool[i % len(pool)])
        rows.append(tuple(row))
    return rows


def load_sample_data(db_manager: DuckDBManager) -> None:
    """Create tables with schema-aware sample data for each configured dataset.

    Controlled by the QUERYSERVICE_SEED_SAMPLE_DATA setting (default True).
    In production, set to False so startup has no seeding side effects.
    """
    settings = get_settings()
    if not settings.seed_sample_data:
        logger.info("Sample data seeding disabled (QUERYSERVICE_SEED_SAMPLE_DATA=false)")
        return

    config = load_datasets_config()
    seeded = 0
    for ds in config.get("datasets", []):
        if not isinstance(ds, dict):
            continue
        dataset_id = ds.get("dataset_id", "")
        fields = ds.get("fields", [])
        if not dataset_id or not fields:
            logger.warning("Skipping dataset entry with missing id or fields")
            continue

        valid_fields = [f for f in fields if isinstance(f, dict) and f.get("name")]
        if not valid_fields:
            logger.warning("Dataset %s has no valid fields, skipping", dataset_id)
            continue

        quoted_id = quote_identifier(dataset_id)
        existing = db_manager.execute_sql(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = ?",
            (dataset_id,),
        )
        if existing and existing[0][0] > 0:
            continue

        col_defs = []
        for f in valid_fields:
            name = f.get("name", "")
            ftype = _DUCKDB_TYPE_MAP.get(f.get("type", "string"), "VARCHAR")
            col_defs.append(f'"{name}" {ftype}')

        create_sql = f"CREATE TABLE {quoted_id} ({', '.join(col_defs)})"
        db_manager.execute_sql(create_sql)

        rows = generate_sample_rows(valid_fields)
        if rows:
            placeholders = ", ".join("?" for _ in valid_fields)
            insert_sql = f"INSERT INTO {quoted_id} VALUES ({placeholders})"
            for row in rows:
                db_manager.execute_sql(insert_sql, row)

        seeded += 1
        logger.info("Seeded sample data for %s (%d rows)", dataset_id, len(rows))

    logger.info(
        "Sample data seeding complete (%d dataset(s))",
        seeded,
        extra={"seeded_count": seeded},
    )
