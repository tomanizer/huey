"""Tests for base relation builder (partition-aware and source-driven)."""

from pathlib import Path

import pytest

from server import datasets
from server.errors import PartitionNotFoundError, ValidationAppError
from server.models import DateRangeRange, DateRangeSingle
from server.relation_builder import BaseRelation, build_base_relation, required_relation_columns


class DummySettings:
    def __init__(self, **kwargs):
        self.max_date_range_days = 366
        self.__dict__.update(kwargs)


def test_sample_table_mode(monkeypatch) -> None:
    settings = DummySettings(execution_mode="sample_table")
    monkeypatch.setattr("server.relation_builder.get_settings", lambda: settings)

    rel = build_base_relation("trades_v1", DateRangeSingle(type="single", date="2026-03-01"), ["symbol"])
    assert isinstance(rel, BaseRelation)
    assert rel.cte_sql is None
    assert rel.from_sql == '"trades_v1"'
    assert rel.params == []
    assert rel.handles_date is False


def test_partition_mode_builds_cte(monkeypatch, tmp_path: Path) -> None:
    dataset_root = tmp_path / "trades_v1" / "date=2026-03-01"
    dataset_root.mkdir(parents=True)
    (dataset_root / "part-0.parquet").touch()

    settings = DummySettings(
        execution_mode="parquet_partitioned",
        partition_base_path=str(tmp_path),
        s3_bucket=None,
    )
    monkeypatch.setattr("server.relation_builder.get_settings", lambda: settings)

    rel = build_base_relation(
        "trades_v1",
        DateRangeSingle(type="single", date="2026-03-01"),
        ["symbol", "date"],
    )

    assert rel.cte_sql is not None
    assert "read_parquet" in rel.cte_sql
    assert "WHERE \"date\" = ?" in rel.cte_sql
    assert rel.from_sql == "base"
    assert rel.handles_date is True
    assert len(rel.params) == 2  # pattern + date param
    assert rel.params[0].endswith("*.parquet")
    assert rel.params[1] == "2026-03-01"


def test_partition_mode_missing_partition(monkeypatch, tmp_path: Path) -> None:
    settings = DummySettings(
        execution_mode="parquet_partitioned",
        partition_base_path=str(tmp_path),
        s3_bucket=None,
    )
    monkeypatch.setattr("server.relation_builder.get_settings", lambda: settings)

    with pytest.raises(PartitionNotFoundError):
        build_base_relation(
            "trades_v1",
            DateRangeRange(type="range", start="2026-03-01", end="2026-03-02"),
            ["symbol", "date"],
        )


def test_partition_mode_rejects_oversized_range_before_path_expansion(monkeypatch) -> None:
    calls = {"count": 0}
    settings = DummySettings(
        execution_mode="parquet_partitioned",
        partition_base_path=None,
        s3_bucket="bucket",
        max_date_range_days=1,
    )
    monkeypatch.setattr("server.relation_builder.get_settings", lambda: settings)

    def count_build_partition_path(bucket: str, dataset_id: str, partition_date: str) -> str:
        calls["count"] += 1
        return f"s3://{bucket}/{dataset_id}/date={partition_date}/"

    monkeypatch.setattr("server.relation_builder.build_partition_path", count_build_partition_path)

    with pytest.raises(ValidationAppError) as exc_info:
        build_base_relation(
            "trades_v1",
            DateRangeRange(type="range", start="2026-03-01", end="2026-03-02"),
            ["symbol", "date"],
        )

    assert calls["count"] == 0
    assert exc_info.value.details["errors"][0]["ctx"] == {"requested_days": 2, "max_days": 1}


def test_partition_mode_source_without_time_filter(monkeypatch, tmp_path: Path) -> None:
    config = tmp_path / "datasets.yaml"
    config.write_text(
        """
datasets:
  - dataset_id: ds_no_time
    source:
      kind: parquet_scan
      uris:
        - s3://bucket/raw/*.parquet
      read_options:
        hive_partitioning: auto
    fields:
      - name: symbol
        type: string
        is_dimension: true
""",
        encoding="utf-8",
    )

    settings = DummySettings(
        execution_mode="parquet_partitioned",
        partition_base_path=None,
        s3_bucket="legacy-bucket",
    )
    monkeypatch.setattr("server.relation_builder.get_settings", lambda: settings)
    monkeypatch.setattr(
        "server.datasets.get_settings",
        lambda: DummySettings(datasets_config_path=str(config), schema_cache_ttl_seconds=0),
    )
    datasets.reset_cache()

    rel = build_base_relation(
        "ds_no_time",
        DateRangeSingle(type="single", date="2026-03-01"),
        ["symbol"],
    )
    assert "read_parquet(?)" in (rel.cte_sql or "")
    assert 'WHERE "date"' not in (rel.cte_sql or "")
    assert rel.params == ["s3://bucket/raw/*.parquet"]
    assert rel.handles_date is False
    assert rel.requires_time_filter is False
    assert required_relation_columns("ds_no_time") == set()


def test_partition_mode_source_with_time_filter(monkeypatch, tmp_path: Path) -> None:
    config = tmp_path / "datasets.yaml"
    config.write_text(
        """
datasets:
  - dataset_id: ds_time
    source:
      kind: parquet_scan
      uris:
        - s3://bucket/trips/*.parquet
      time_filter:
        column: tpep_pickup_datetime
        type: timestamp
      read_options:
        hive_partitioning: false
    fields:
      - name: tpep_pickup_datetime
        type: string
        is_dimension: true
      - name: symbol
        type: string
        is_dimension: true
""",
        encoding="utf-8",
    )

    settings = DummySettings(
        execution_mode="parquet_partitioned",
        partition_base_path=None,
        s3_bucket="legacy-bucket",
    )
    monkeypatch.setattr("server.relation_builder.get_settings", lambda: settings)
    monkeypatch.setattr(
        "server.datasets.get_settings",
        lambda: DummySettings(datasets_config_path=str(config), schema_cache_ttl_seconds=0),
    )
    datasets.reset_cache()

    rel = build_base_relation(
        "ds_time",
        DateRangeRange(type="range", start="2026-03-01", end="2026-03-02"),
        ["symbol"],
    )
    cte = rel.cte_sql or ""
    assert "CAST(\"tpep_pickup_datetime\" AS DATE) BETWEEN ? AND ?" in cte
    assert rel.params[-2:] == ["2026-03-01", "2026-03-02"]
    assert rel.handles_date is True
    assert rel.requires_time_filter is True
    assert required_relation_columns("ds_time") == {"tpep_pickup_datetime"}
