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
from typing import Any, Literal
from urllib.parse import quote

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator

from server.config import get_settings
from server.engine import DuckDBManager, db_manager
from server.errors import DatasetConfigError
from server.models import (
    DateRangeSpanLimitError,
    raise_date_range_validation_error,
    validate_date_range_span,
)
from server.utils import quote_identifier

logger = logging.getLogger("query_service.datasets")


@dataclass
class _SchemaCacheEntry:
    schema: dict[str, Any] | None
    loaded_at: float


@dataclass
class _DatasetProfileCacheEntry:
    profile: dict[str, Any]
    loaded_at: float
    includes_distinct_counts: bool


class DatasetSourceReadOptions(BaseModel):
    """Typed options for DuckDB read_parquet()."""

    hive_partitioning: Literal["auto"] | bool = "auto"
    union_by_name: bool = False
    filename: bool = False
    hive_types: dict[str, str] | None = None


class DatasetPartitionKey(BaseModel):
    """Optional metadata about partition keys in the physical source."""

    name: str
    role: Literal["date", "business_date", "none"] = "none"
    type: str | None = None


class DatasetTimeFilter(BaseModel):
    """Optional time filter mapping from API date_range to a source column."""

    column: str
    type: Literal["date", "timestamp", "string"] = "date"


class DatasetSourceConfig(BaseModel):
    """Per-dataset physical source definition for parquet_scan relation planning."""

    kind: Literal["parquet_scan"] = "parquet_scan"
    uris: str | list[str]
    read_options: DatasetSourceReadOptions = Field(default_factory=DatasetSourceReadOptions)
    partitions: list[DatasetPartitionKey] = Field(default_factory=list)
    time_filter: DatasetTimeFilter | None = None
    max_files: int | None = Field(default=None, ge=1)

    @field_validator("uris")
    @classmethod
    def _validate_uris(cls, value: str | list[str]) -> str | list[str]:
        if isinstance(value, str):
            if value.strip() == "":
                raise ValueError("source.uris must not be empty")
            return value
        if not value:
            raise ValueError("source.uris must include at least one path")
        cleaned = [u for u in value if isinstance(u, str) and u.strip()]
        if not cleaned:
            raise ValueError("source.uris must include at least one non-empty path")
        return cleaned

    def normalized_uris(self) -> list[str]:
        if isinstance(self.uris, str):
            return [self.uris]
        return list(self.uris)


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
        path_source = "default"
    else:
        path = Path(path)
        path_source = "QUERYSERVICE_DATASETS_CONFIG_PATH"

    path_resolved = path.resolve()
    logger.info(
        "Loading datasets config from %s (source: %s)",
        path_resolved,
        path_source,
        extra={"config_path": str(path_resolved), "config_source": path_source},
    )

    if not path.exists():
        logger.warning("Datasets config path does not exist: %s", path_resolved)
        return {"datasets": []}

    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)

    if not data or not isinstance(data, dict):
        logger.warning("Datasets config empty or invalid at %s", path_resolved)
        return {"datasets": []}
    if "datasets" not in data or not isinstance(data["datasets"], list):
        logger.warning("Datasets config has no 'datasets' list at %s", path_resolved)
        return {"datasets": []}

    datasets_list = data["datasets"]
    dataset_ids = [
        d.get("dataset_id") for d in datasets_list if isinstance(d, dict) and d.get("dataset_id")
    ]
    logger.info(
        "Loaded datasets config from %s: %d dataset(s) %s",
        path_resolved,
        len(dataset_ids),
        dataset_ids,
        extra={"config_path": str(path_resolved), "dataset_count": len(dataset_ids), "dataset_ids": dataset_ids},
    )
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
    try:
        validate_date_range_span(date_range, get_settings().max_date_range_days)
    except DateRangeSpanLimitError as exc:
        raise_date_range_validation_error(exc)
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
        self._dataset_entries: dict[str, dict[str, Any] | None] = {}
        self._dataset_sources: dict[str, DatasetSourceConfig | None] = {}
        self._dataset_profiles: dict[str, _DatasetProfileCacheEntry] = {}
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
            self._dataset_entries.clear()
            self._dataset_sources.clear()
            self._dataset_profiles.clear()
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

    @staticmethod
    def _parse_dataset_source(dataset_id: str, dataset_entry: dict[str, Any] | None) -> DatasetSourceConfig | None:
        if not dataset_entry:
            return None
        source_value = dataset_entry.get("source")
        if source_value is None:
            return None
        if not isinstance(source_value, dict):
            raise DatasetConfigError(
                dataset_id,
                "Dataset source must be an object",
                {"field": "source"},
            )
        try:
            return DatasetSourceConfig.model_validate(source_value)
        except ValidationError as exc:
            raise DatasetConfigError(
                dataset_id,
                "Dataset source validation failed",
                {"field": "source", "errors": exc.errors()},
            ) from exc

    def _store_schema_locked(
        self,
        dataset_id: str,
        schema: dict[str, Any] | None,
        dataset_entry: dict[str, Any] | None = None,
    ) -> None:
        loaded_at = time.monotonic()
        field_names = self._extract_field_names(schema)
        self._schemas[dataset_id] = _SchemaCacheEntry(schema=schema, loaded_at=loaded_at)
        self._schema_fields[dataset_id] = field_names
        self._dataset_entries[dataset_id] = dataset_entry
        self._dataset_sources[dataset_id] = self._parse_dataset_source(dataset_id, dataset_entry)

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
        dataset_entry = None
        config = load_datasets_config()
        for ds in config.get("datasets", []):
            if isinstance(ds, dict) and ds.get("dataset_id") == dataset_id:
                dataset_entry = ds
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
            self._store_schema_locked(dataset_id, schema, dataset_entry)
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

    def get_dataset_entry(self, dataset_id: str) -> dict[str, Any] | None:
        """Return raw dataset entry from config for a dataset_id."""
        self.get_schema(dataset_id)
        with self._lock:
            entry = self._dataset_entries.get(dataset_id)
            return dict(entry) if entry else None

    def get_dataset_source(self, dataset_id: str) -> DatasetSourceConfig | None:
        """Return parsed source metadata for a dataset, if present."""
        self.get_schema(dataset_id)
        with self._lock:
            return self._dataset_sources.get(dataset_id)

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
            self._dataset_entries.clear()
            self._dataset_sources.clear()
            self._dataset_profiles.clear()
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


def get_dataset_entry(dataset_id: str) -> dict[str, Any] | None:
    """Return the raw dataset config entry for a dataset_id."""
    return _schema_cache.get_dataset_entry(dataset_id)


def get_dataset_source(dataset_id: str) -> DatasetSourceConfig | None:
    """Return parsed per-dataset source metadata, if configured."""
    return _schema_cache.get_dataset_source(dataset_id)


def list_dataset_entries() -> list[dict[str, Any]]:
    """Return all dataset config entries sorted by dataset_id."""
    config = load_datasets_config()
    entries = [entry for entry in config.get("datasets", []) if isinstance(entry, dict) and entry.get("dataset_id")]
    return sorted((dict(entry) for entry in entries), key=lambda entry: str(entry["dataset_id"]))


def _infer_field_role(field: dict[str, Any]) -> str:
    if field.get("is_measure"):
        return "measure"
    return "dimension"


def _infer_source_kind(dataset_entry: dict[str, Any]) -> str:
    source = dataset_entry.get("source")
    if isinstance(source, dict) and source.get("kind"):
        return str(source["kind"])
    return str(get_settings().execution_mode)


def _infer_time_dimension(
    dataset_entry: dict[str, Any],
    source: DatasetSourceConfig | None,
    profile: dict[str, Any] | None,
) -> dict[str, Any] | None:
    configured = dataset_entry.get("time_dimension")
    time_dimension: dict[str, Any] | None = dict(configured) if isinstance(configured, dict) else None
    if time_dimension is None:
        field_name = None
        if source and source.time_filter is not None:
            field_name = source.time_filter.column
        else:
            for field in dataset_entry.get("fields", []):
                if isinstance(field, dict) and field.get("name") == "date":
                    field_name = "date"
                    break
        if not field_name:
            return None
        time_dimension = {"field": field_name}

    if "max_range_days" not in time_dimension:
        time_dimension["max_range_days"] = get_settings().max_date_range_days
    if profile:
        if profile.get("time_min") and "min" not in time_dimension:
            time_dimension["min"] = profile["time_min"]
        if profile.get("time_max") and "max" not in time_dimension:
            time_dimension["max"] = profile["time_max"]
    return time_dimension


def get_time_dimension(dataset_id: str) -> dict[str, Any] | None:
    """Return the configured or inferred time dimension metadata for a dataset."""
    entry = get_dataset_entry(dataset_id)
    if entry is None:
        return None
    source = get_dataset_source(dataset_id)
    return _infer_time_dimension(entry, source, None)

def _compute_dataset_profile(
    dataset_id: str,
    dataset_entry: dict[str, Any],
    source: DatasetSourceConfig | None,
    *,
    include_distinct_counts: bool,
) -> dict[str, Any]:
    profile: dict[str, Any] = {
        "row_count": dataset_entry.get("row_count"),
        "distinct_counts": {},
        "time_min": None,
        "time_max": None,
    }
    if not db_manager.is_initialized or not db_manager.table_exists(dataset_id):
        return profile

    table_name = quote_identifier(dataset_id)
    row_count_rows = db_manager.execute_sql(f"SELECT COUNT(*) FROM {table_name}")
    if row_count_rows:
        profile["row_count"] = int(row_count_rows[0][0])

    fields_to_profile = [
        str(field["name"])
        for field in dataset_entry.get("fields", [])
        if isinstance(field, dict) and field.get("name")
    ]
    field_names = set(fields_to_profile)
    if include_distinct_counts and fields_to_profile:
        distinct_counts_selects = ", ".join(
            f"COUNT(DISTINCT {quote_identifier(field_name)})" for field_name in fields_to_profile
        )
        rows = db_manager.execute_sql(f"SELECT {distinct_counts_selects} FROM {table_name}")
        if rows:
            for index, field_name in enumerate(fields_to_profile):
                profile["distinct_counts"][field_name] = int(rows[0][index])

    time_field = None
    if source and source.time_filter is not None:
        time_field = source.time_filter.column
    elif "date" in field_names:
        time_field = "date"
    if time_field:
        quoted_time_field = quote_identifier(time_field)
        rows = db_manager.execute_sql(
            f"SELECT CAST(MIN({quoted_time_field}) AS VARCHAR), CAST(MAX({quoted_time_field}) AS VARCHAR) FROM {table_name}"
        )
        if rows:
            profile["time_min"], profile["time_max"] = rows[0]

    return profile


def get_dataset_profile(dataset_id: str, *, include_distinct_counts: bool = False) -> dict[str, Any]:
    """Return cached discovery/profile metadata for a dataset."""
    entry = get_dataset_entry(dataset_id)
    if entry is None:
        return {
            "row_count": None,
            "distinct_counts": {},
            "time_min": None,
            "time_max": None,
        }
    source = get_dataset_source(dataset_id)
    with _schema_cache._lock:
        cached = _schema_cache._dataset_profiles.get(dataset_id)
        if (
            cached
            and not _schema_cache._is_expired(cached.loaded_at)
            and (not include_distinct_counts or cached.includes_distinct_counts)
        ):
            return dict(cached.profile)

    profile = _compute_dataset_profile(
        dataset_id,
        entry,
        source,
        include_distinct_counts=include_distinct_counts,
    )
    with _schema_cache._lock:
        _schema_cache._dataset_profiles[dataset_id] = _DatasetProfileCacheEntry(
            profile=dict(profile),
            loaded_at=time.monotonic(),
            includes_distinct_counts=include_distinct_counts,
        )
    return dict(profile)


def get_dataset_schema_version(dataset_id: str) -> str:
    """Return a stable version token for dataset discovery responses."""
    entry = get_dataset_entry(dataset_id)
    payload = {
        "dataset_id": dataset_id,
        "entry": entry,
        "dim_version_token": get_dim_version_token(dataset_id),
    }
    digest = hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:8]
    return f"v1-{digest}"


def get_dataset_etag(dataset_id: str) -> str:
    """Return an HTTP ETag for dataset metadata/schema."""
    return f"\"{get_dataset_schema_version(dataset_id)}\""


def build_dataset_links(dataset_id: str) -> dict[str, str]:
    """Return canonical v1 links for a dataset."""
    encoded_dataset_id = quote(dataset_id, safe="")
    base = f"/api/v1/datasets/{encoded_dataset_id}"
    return {
        "self": base,
        "schema": f"{base}/schema",
        "tuples": f"{base}/query/tuples",
        "cells": f"{base}/query/cells",
        "members": f"{base}/query/members",
    }


def get_dataset_summary(dataset_id: str) -> dict[str, Any] | None:
    """Return summary discovery metadata for a dataset."""
    entry = get_dataset_entry(dataset_id)
    if entry is None:
        return None
    profile = get_dataset_profile(dataset_id, include_distinct_counts=False)
    source = get_dataset_source(dataset_id)
    fields = entry.get("fields", [])
    summary: dict[str, Any] = {
        "id": dataset_id,
        "display_name": entry.get("display_name") or dataset_id,
        "field_count": len(fields),
        "links": build_dataset_links(dataset_id),
    }
    if entry.get("description"):
        summary["description"] = entry["description"]
    if profile.get("row_count") is not None:
        summary["row_count"] = profile["row_count"]
    time_dimension = _infer_time_dimension(entry, source, profile)
    if time_dimension is not None:
        summary["time_dimension"] = time_dimension
    return summary


def get_dataset_details(dataset_id: str) -> dict[str, Any] | None:
    """Return full discovery metadata for a dataset."""
    entry = get_dataset_entry(dataset_id)
    if entry is None:
        return None
    profile = get_dataset_profile(dataset_id, include_distinct_counts=True)
    source = get_dataset_source(dataset_id)
    fields = []
    for field in entry.get("fields", []):
        if not isinstance(field, dict) or not field.get("name"):
            continue
        field_name = str(field["name"])
        field_payload = {
            "name": field_name,
            "type": field.get("type"),
            "role": _infer_field_role(field),
            "nullable": field.get("nullable"),
            "distinct_count": profile.get("distinct_counts", {}).get(field_name),
        }
        fields.append(field_payload)

    details: dict[str, Any] = {
        "id": dataset_id,
        "display_name": entry.get("display_name") or dataset_id,
        "description": entry.get("description"),
        "source_kind": _infer_source_kind(entry),
        "size_bytes": entry.get("size_bytes"),
        "row_count": profile.get("row_count"),
        "version": get_dataset_schema_version(dataset_id),
        "fields": fields,
        "links": build_dataset_links(dataset_id),
    }
    time_dimension = _infer_time_dimension(entry, source, profile)
    if time_dimension is not None:
        details["time_dimension"] = time_dimension
    return details


def get_discovery_schema(dataset_id: str) -> dict[str, Any] | None:
    """Return the lightweight v1 schema payload for a dataset."""
    entry = get_dataset_entry(dataset_id)
    if entry is None:
        return None
    return {
        "dataset_id": dataset_id,
        "version": get_dataset_schema_version(dataset_id),
        "fields": [
            {
                "name": field["name"],
                "type": field.get("type"),
                "role": _infer_field_role(field),
            }
            for field in entry.get("fields", [])
            if isinstance(field, dict) and field.get("name")
        ],
    }


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


def get_dim_version_token(dataset_id: str) -> str:
    """Return a version token that identifies the current state of dimension data.

    The token is included in picklist cache keys so that any change to the
    dataset's configuration (field definitions, config file mtime) automatically
    causes a cache miss and a fresh computation.

    If ``QUERYSERVICE_DIM_VERSION_TOKEN`` is set in the environment, that value
    is returned directly.  This allows operators to force a global invalidation
    (e.g. after a reference-data reload) or coordinate token values across a
    multi-node deployment.

    Otherwise the token is derived from the datasets config file identity and
    the field definitions for the given dataset.
    """
    settings = get_settings()
    external = getattr(settings, "dim_version_token", None)
    if external:
        return str(external)

    # Compute a stable token from config mtime + dataset field definitions.
    entry = get_dataset_entry(dataset_id)
    fields = entry.get("fields", []) if entry else []

    cfg_path = settings.datasets_config_path
    path = Path(cfg_path) if cfg_path else _default_config_path()
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        mtime = None

    token_input = json.dumps(
        {"config_path": str(path), "config_mtime": mtime, "dataset_id": dataset_id, "fields": fields},
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(token_input.encode()).hexdigest()[:16]


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
