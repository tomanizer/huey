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


def load_sample_data(db_manager: DuckDBManager) -> None:
    """
    Create tables with sample data for each configured dataset.

    In production, data comes from parquet/S3. For development and testing,
    this populates in-memory DuckDB tables matching the dataset schemas.
    """
    config = load_datasets_config()
    for ds in config.get("datasets", []):
        if not isinstance(ds, dict):
            continue
        dataset_id = ds.get("dataset_id", "")
        fields = ds.get("fields", [])
        if not dataset_id or not fields:
            continue

        quoted_id = '"' + dataset_id.replace('"', '""') + '"'
        existing = db_manager.execute_sql(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = ?",
            (dataset_id,),
        )
        if existing and existing[0][0] > 0:
            continue

        col_defs = []
        for f in fields:
            name = f.get("name", "")
            ftype = _DUCKDB_TYPE_MAP.get(f.get("type", "string"), "VARCHAR")
            col_defs.append(f'"{name}" {ftype}')

        create_sql = f"CREATE TABLE {quoted_id} ({', '.join(col_defs)})"
        db_manager.execute_sql(create_sql)

        insert_sql = f"""
            INSERT INTO {quoted_id} VALUES
            ('2026-03-01', 'AAPL', 1500),
            ('2026-03-01', 'GOOG', 2200),
            ('2026-03-01', 'MSFT', 1800),
            ('2026-03-01', 'AMZN', 3100),
            ('2026-03-01', 'TSLA', 900),
            ('2026-03-02', 'AAPL', 1600),
            ('2026-03-02', 'GOOG', 2100),
            ('2026-03-02', 'MSFT', 1900)
        """
        db_manager.execute_sql(insert_sql)
        logger.info("Loaded sample data for %s (%d rows)", dataset_id, 8)
