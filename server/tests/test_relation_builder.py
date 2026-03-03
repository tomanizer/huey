"""Tests for base relation builder (partition-aware)."""

from pathlib import Path

import pytest

from server.errors import PartitionNotFoundError
from server.models import DateRangeRange, DateRangeSingle
from server.relation_builder import BaseRelation, build_base_relation


class DummySettings:
    def __init__(self, **kwargs):
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
