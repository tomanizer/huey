"""Tests for S3 connectivity and partition path handling."""

from pathlib import Path

import duckdb
import pytest

from server import s3


def test_build_partition_path() -> None:
    path = s3.build_partition_path("my-bucket", "trades_v1", "2026-03-01")
    assert path == "s3://my-bucket/trades_v1/date=2026-03-01/"


def test_sample_partition_read_local(tmp_path: Path) -> None:
    parquet_file = tmp_path / "part-0.parquet"
    conn = duckdb.connect(":memory:")
    conn.execute("CREATE TABLE t AS SELECT 1 AS a, 2 AS b")
    conn.execute(f"COPY t TO '{parquet_file}' (FORMAT PARQUET)")
    conn.close()

    count = s3.sample_partition_read(
        "b", "d", "2026-01-01",
        path_override=str(parquet_file),
    )
    assert count == 1


def test_sample_partition_read_if_configured_no_bucket() -> None:
    result = s3.sample_partition_read_if_configured("ds", "2026-01-01")
    assert result is None


class TestValidateRegion:
    def test_valid_regions(self) -> None:
        assert s3._validate_region("us-east-1") == "us-east-1"
        assert s3._validate_region("eu-west-2") == "eu-west-2"
        assert s3._validate_region("ap-southeast-1") == "ap-southeast-1"

    def test_invalid_region_rejects_injection(self) -> None:
        with pytest.raises(ValueError, match="Invalid AWS region"):
            s3._validate_region("us-east-1'; DROP TABLE x;--")

    def test_invalid_region_empty(self) -> None:
        with pytest.raises(ValueError, match="Invalid AWS region"):
            s3._validate_region("")

    def test_invalid_region_wrong_format(self) -> None:
        with pytest.raises(ValueError, match="Invalid AWS region"):
            s3._validate_region("US-EAST-1")
