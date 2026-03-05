"""
Dataset configuration loader.

Loads dataset and schema metadata from a YAML config file (e.g. dataset_id, fields).
"""

import hashlib
import json
import logging
import threading
import time
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import yaml

from server.config import get_settings
from server.engine import DuckDBManager
from server.utils import quote_identifier

logger = logging.getLogger("query_service.datasets")


@dataclass
class _SchemaCacheEntry:
    schema: dict[str, Any] | None
    loaded_at: float


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


def _canonicalize(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _canonicalize(obj[k]) for k in sorted(obj)}
    if isinstance(obj, (list, tuple)):
        return [_canonicalize(v) for v in obj]
    if isinstance(obj, set):
        return sorted(_canonicalize(v) for v in obj)
    return obj


def _canonical_json(obj: Any) -> str:
    return json.dumps(_canonicalize(obj), separators=(",", ":"), sort_keys=True, ensure_ascii=True)


def _dates_for_scope(date_range: Any) -> set[str] | None:
    if date_range is None:
        return None
    dtype = getattr(date_range, "type", None)
    if dtype is None and isinstance(date_range, dict):
        dtype = date_range.get("type")
    if dtype == "single":
        value = getattr(date_range, "date", None) if not isinstance(date_range, dict) else date_range.get("date")
        return {value} if isinstance(value, str) and value else None
    if dtype == "range":
        start = getattr(date_range, "start", None) if not isinstance(date_range, dict) else date_range.get("start")
        end = getattr(date_range, "end", None) if not isinstance(date_range, dict) else date_range.get("end")
        if not (isinstance(start, str) and isinstance(end, str) and start and end):
            return None
        start_date = date.fromisoformat(start)
        end_date = date.fromisoformat(end)
        days: set[str] = set()
        cursor = start_date
        while cursor <= end_date:
            days.add(cursor.isoformat())
            cursor += timedelta(days=1)
        return days
    return None


def _normalize_partition_records(metadata: Any, date_scope: set[str] | None) -> list[dict[str, Any]]:
    if metadata is None:
        return []

    records: list[dict[str, Any]] = []
    if isinstance(metadata, dict) and isinstance(metadata.get("partitions"), list):
        source = metadata.get("partitions", [])
    elif isinstance(metadata, dict):
        source = [{"date": key, "meta": value} for key, value in metadata.items()]
    elif isinstance(metadata, list):
        source = metadata
    else:
        source = [metadata]

    for item in source:
        if isinstance(item, dict):
            partition_date = item.get("date") or item.get("partition_date")
            if date_scope and isinstance(partition_date, str) and partition_date not in date_scope:
                continue

            files = item.get("files")
            if isinstance(files, list):
                normalized_files: list[dict[str, Any]] = []
                for f in files:
                    if isinstance(f, dict):
                        normalized_files.append(
                            {
                                "path": f.get("path"),
                                "size": f.get("size"),
                                "modified": f.get("modified") or f.get("mtime") or f.get("last_modified"),
                                "etag": f.get("etag"),
                            }
                        )
                    else:
                        normalized_files.append({"path": str(f)})
                normalized_files.sort(key=lambda x: _canonical_json(x))
                records.append({"date": partition_date, "files": normalized_files})
            else:
                records.append(item)
        else:
            records.append({"value": item})
    records.sort(key=lambda x: _canonical_json(x))
    return records


class _DatasetSchemaCache:
    """In-memory cache for dataset schema + derived metadata."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._schemas: dict[str, _SchemaCacheEntry] = {}
        self._schema_fields: dict[str, set[str]] = {}
        self._partition_metadata: dict[str, Any] = {}
        self._config_path: str | None = None
        self._config_mtime: float | None = None
        self._counters = {"cache_hit": 0, "cache_miss": 0, "refresh_count": 0}
        self._ttl_seconds: float | None = None
        self._refresh_settings()

    def _refresh_settings(self) -> None:
        settings = get_settings()
        try:
            ttl = settings.schema_cache_ttl_seconds
        except AttributeError:
            ttl = None
        self._ttl_seconds = ttl if (ttl is not None and ttl > 0) else None

    def _config_identity(self) -> tuple[str, float | None]:
        settings = get_settings()
        cfg_path = settings.datasets_config_path
        path = Path(cfg_path) if cfg_path else _default_config_path()
        try:
            mtime = path.stat().st_mtime
        except FileNotFoundError:
            mtime = None
        return str(path), mtime

    def _invalidate_if_config_changed_locked(self, path: str, mtime: float | None) -> None:
        if self._config_path is None:
            self._config_path = path
            self._config_mtime = mtime
            return
        if path != self._config_path or mtime != self._config_mtime:
            self._config_path = path
            self._config_mtime = mtime
            self._schemas.clear()
            self._schema_fields.clear()
            self._partition_metadata.clear()
            self._counters["refresh_count"] += 1
            logger.info(
                "dataset cache refreshed (config change detected)",
                extra={"cache_event": "refresh", "config_path": path},
            )

    def _is_expired(self, loaded_at: float) -> bool:
        if not self._ttl_seconds:
            return False
        return (time.monotonic() - loaded_at) > self._ttl_seconds

    @staticmethod
    def _extract_field_names(schema: dict[str, Any] | None) -> set[str]:
        if not schema:
            return set()
        return {
            f["name"]
            for f in schema.get("fields", [])
            if isinstance(f, dict) and "name" in f
        }

    def _store_schema_locked(self, dataset_id: str, schema: dict[str, Any] | None) -> None:
        loaded_at = time.monotonic()
        field_names = self._extract_field_names(schema)
        self._schemas[dataset_id] = _SchemaCacheEntry(schema=schema, loaded_at=loaded_at)
        self._schema_fields[dataset_id] = field_names

    def get_schema(self, dataset_id: str) -> dict[str, Any] | None:
        """
        Return cached schema for the given dataset.

        Refreshes on cache miss, TTL expiry, or config change. The returned schema is shared and must be treated as read-only.
        """
        # Resolve config identity before acquiring the lock so file stat I/O
        # doesn't block unrelated cache operations.
        identity = self._config_identity()
        with self._lock:
            self._refresh_settings()
            self._invalidate_if_config_changed_locked(*identity)
            entry = self._schemas.get(dataset_id)
            if entry and not self._is_expired(entry.loaded_at):
                self._counters["cache_hit"] += 1
                logger.debug(
                    "dataset schema cache hit",
                    extra={"cache_event": "hit", "dataset_id": dataset_id},
                )
                return entry.schema

        # YAML parsing can be expensive; do it outside the lock.
        schema = None
        config = load_datasets_config()
        for ds in config.get("datasets", []):
            if isinstance(ds, dict) and ds.get("dataset_id") == dataset_id:
                schema = {"dataset_id": dataset_id, "fields": ds.get("fields", [])}
                break

        # Double-check once more to avoid overwriting a fresh cache entry that
        # may have been populated by another thread while we were loading YAML.
        identity = self._config_identity()
        with self._lock:
            self._refresh_settings()
            self._invalidate_if_config_changed_locked(*identity)
            entry = self._schemas.get(dataset_id)
            if entry and not self._is_expired(entry.loaded_at):
                self._counters["cache_hit"] += 1
                logger.debug(
                    "dataset schema cache hit (post-load)",
                    extra={"cache_event": "hit", "dataset_id": dataset_id},
                )
                return entry.schema

            if entry and self._is_expired(entry.loaded_at):
                self._counters["refresh_count"] += 1
            self._counters["cache_miss"] += 1
            self._store_schema_locked(dataset_id, schema)
            logger.info(
                "dataset schema cached",
                extra={
                    "cache_event": "miss" if entry is None else "refresh",
                    "dataset_id": dataset_id,
                    "cache_hit": self._counters["cache_hit"],
                    "cache_miss": self._counters["cache_miss"],
                },
            )
            return schema

    def get_schema_field_names(self, dataset_id: str) -> set[str]:
        """Return cached field-name set for a dataset."""
        schema = self.get_schema(dataset_id)
        with self._lock:
            if schema is None:
                return set()
            fields = self._schema_fields.get(dataset_id)
            if fields is None:
                return set()
            return set(fields)

    def set_partition_metadata(self, dataset_id: str, metadata: Any) -> None:
        """Store per-dataset partition metadata (e.g., shard descriptors) for partition-native execution."""
        with self._lock:
            self._partition_metadata[dataset_id] = metadata

    def get_partition_metadata(self, dataset_id: str) -> Any:
        with self._lock:
            return self._partition_metadata.get(dataset_id)

    def clear_partition_metadata(self, dataset_id: str | None = None) -> None:
        with self._lock:
            if dataset_id is None:
                self._partition_metadata.clear()
            else:
                self._partition_metadata.pop(dataset_id, None)

    def get_data_version_token(self, dataset_id: str, date_range: Any) -> str | None:
        date_scope = _dates_for_scope(date_range)
        with self._lock:
            metadata = self._partition_metadata.get(dataset_id)
        records = _normalize_partition_records(metadata, date_scope)
        if not records:
            return None
        digest = hashlib.sha256(_canonical_json(records).encode("utf-8")).hexdigest()
        return digest

    def reset(self) -> None:
        with self._lock:
            self._schemas.clear()
            self._schema_fields.clear()
            self._partition_metadata.clear()
            self._counters = {"cache_hit": 0, "cache_miss": 0, "refresh_count": 0}
            self._config_path = None
            self._config_mtime = None
            self._refresh_settings()

    def stats(self) -> dict[str, int]:
        with self._lock:
            return dict(self._counters)


_schema_cache = _DatasetSchemaCache()


def get_schema(dataset_id: str) -> dict[str, Any] | None:
    """
    Return schema for a dataset: { dataset_id, fields }.
    Returns None if dataset_id is not found. The returned object is shared and should be treated as read-only.
    """
    return _schema_cache.get_schema(dataset_id)


def get_schema_field_names(dataset_id: str) -> set[str]:
    """Return the set of field names defined in the schema for a dataset."""
    return _schema_cache.get_schema_field_names(dataset_id)


def get_partition_metadata(dataset_id: str) -> Any:
    """Return cached partition metadata for dataset (used by partition-native execution paths)."""
    return _schema_cache.get_partition_metadata(dataset_id)


def set_partition_metadata(dataset_id: str, metadata: Any) -> None:
    _schema_cache.set_partition_metadata(dataset_id, metadata)


def clear_partition_metadata(dataset_id: str | None = None) -> None:
    _schema_cache.clear_partition_metadata(dataset_id)


def get_data_version_token(dataset_id: str, date_range: Any) -> str | None:
    """Return deterministic partition metadata token for dataset/date scope."""
    return _schema_cache.get_data_version_token(dataset_id, date_range)


def reset_cache() -> None:
    """Reset caches (used in tests or after config reload)."""
    _schema_cache.reset()


def get_cache_stats() -> dict[str, int]:
    """Expose instrumentation counters."""
    return _schema_cache.stats()


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

    Controlled by the QUERYSERVICE_SEED_SAMPLE_DATA setting (default False).
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
