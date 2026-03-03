"""Tests for schema-aware sample data seeding."""

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from server.datasets import generate_sample_rows, load_sample_data
from server.engine import DuckDBManager


@pytest.fixture
def fresh_db():
    """A clean DuckDB instance with no tables."""
    db = DuckDBManager()
    db.initialize()
    yield db
    db.shutdown()


class TestGenerateSampleRows:
    def test_basic_trades_schema(self) -> None:
        fields = [
            {"name": "date", "type": "date"},
            {"name": "symbol", "type": "string"},
            {"name": "volume", "type": "int64"},
        ]
        rows = generate_sample_rows(fields)
        assert len(rows) == 8
        assert all(len(r) == 3 for r in rows)

    def test_deterministic(self) -> None:
        fields = [{"name": "x", "type": "string"}]
        assert generate_sample_rows(fields) == generate_sample_rows(fields)

    def test_all_types(self) -> None:
        fields = [
            {"name": "d", "type": "date"},
            {"name": "s", "type": "string"},
            {"name": "i", "type": "int64"},
            {"name": "f", "type": "float64"},
            {"name": "b", "type": "boolean"},
        ]
        rows = generate_sample_rows(fields)
        assert len(rows) == 8
        assert all(len(r) == 5 for r in rows)
        assert isinstance(rows[0][0], str)
        assert isinstance(rows[0][2], int)
        assert isinstance(rows[0][3], float)
        assert isinstance(rows[0][4], bool)

    def test_unknown_type_falls_back_to_string(self) -> None:
        fields = [{"name": "custom", "type": "custom_type"}]
        rows = generate_sample_rows(fields)
        assert len(rows) == 8
        assert all(isinstance(r[0], str) for r in rows)

    def test_single_field(self) -> None:
        fields = [{"name": "id", "type": "int64"}]
        rows = generate_sample_rows(fields)
        assert len(rows) == 8
        assert all(isinstance(r[0], int) for r in rows)

    def test_schema_with_extra_metadata(self) -> None:
        fields = [
            {"name": "date", "type": "date", "is_dimension": True},
            {"name": "val", "type": "float64", "is_measure": True},
        ]
        rows = generate_sample_rows(fields)
        assert len(rows) == 8
        assert all(len(r) == 2 for r in rows)


class TestLoadSampleData:
    def test_seeds_when_enabled(self, fresh_db: DuckDBManager) -> None:
        config_yaml = """
datasets:
  - dataset_id: test_ds
    fields:
      - name: id
        type: int64
      - name: label
        type: string
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
            f.write(config_yaml)
            path = f.name
        try:
            with patch("server.datasets.get_settings") as mock_settings:
                mock_settings.return_value = type("S", (), {
                    "datasets_config_path": path,
                    "seed_sample_data": True,
                })()
                load_sample_data(fresh_db)

            rows = fresh_db.execute_sql("SELECT count(*) FROM test_ds")
            assert rows[0][0] == 8
        finally:
            Path(path).unlink()

    def test_skips_when_disabled(self, fresh_db: DuckDBManager) -> None:
        config_yaml = """
datasets:
  - dataset_id: disabled_ds
    fields:
      - name: id
        type: int64
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
            f.write(config_yaml)
            path = f.name
        try:
            with patch("server.datasets.get_settings") as mock_settings:
                mock_settings.return_value = type("S", (), {
                    "datasets_config_path": path,
                    "seed_sample_data": False,
                })()
                load_sample_data(fresh_db)

            tables = fresh_db.execute_sql(
                "SELECT count(*) FROM information_schema.tables WHERE table_name = 'disabled_ds'"
            )
            assert tables[0][0] == 0
        finally:
            Path(path).unlink()

    def test_resilient_to_schema_evolution(self, fresh_db: DuckDBManager) -> None:
        """Adding a new field to the schema doesn't crash seeding."""
        config_yaml = """
datasets:
  - dataset_id: evolved_ds
    fields:
      - name: date
        type: date
      - name: symbol
        type: string
      - name: volume
        type: int64
      - name: price
        type: float64
      - name: is_active
        type: boolean
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
            f.write(config_yaml)
            path = f.name
        try:
            with patch("server.datasets.get_settings") as mock_settings:
                mock_settings.return_value = type("S", (), {
                    "datasets_config_path": path,
                    "seed_sample_data": True,
                })()
                load_sample_data(fresh_db)

            rows = fresh_db.execute_sql("SELECT count(*) FROM evolved_ds")
            assert rows[0][0] == 8
            sample = fresh_db.execute_sql("SELECT * FROM evolved_ds LIMIT 1")
            assert len(sample[0]) == 5
        finally:
            Path(path).unlink()

    def test_skips_dataset_with_no_fields(self, fresh_db: DuckDBManager) -> None:
        config_yaml = """
datasets:
  - dataset_id: empty_fields
    fields: []
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
            f.write(config_yaml)
            path = f.name
        try:
            with patch("server.datasets.get_settings") as mock_settings:
                mock_settings.return_value = type("S", (), {
                    "datasets_config_path": path,
                    "seed_sample_data": True,
                })()
                load_sample_data(fresh_db)

            tables = fresh_db.execute_sql(
                "SELECT count(*) FROM information_schema.tables WHERE table_name = 'empty_fields'"
            )
            assert tables[0][0] == 0
        finally:
            Path(path).unlink()

    def test_idempotent_does_not_duplicate(self, fresh_db: DuckDBManager) -> None:
        config_yaml = """
datasets:
  - dataset_id: idempotent_ds
    fields:
      - name: val
        type: int64
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
            f.write(config_yaml)
            path = f.name
        try:
            with patch("server.datasets.get_settings") as mock_settings:
                mock_settings.return_value = type("S", (), {
                    "datasets_config_path": path,
                    "seed_sample_data": True,
                })()
                load_sample_data(fresh_db)
                load_sample_data(fresh_db)

            rows = fresh_db.execute_sql("SELECT count(*) FROM idempotent_ds")
            assert rows[0][0] == 8
        finally:
            Path(path).unlink()
