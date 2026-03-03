"""Unit tests for SQL query builder."""

from server.models import (
    CellsQueryBody,
    DateRangeRange,
    DateRangeSingle,
    ExportQueryBody,
    PagingSpec,
    PicklistQueryBody,
    TupleFieldSpec,
    TupleFilter,
    TuplesQueryBody,
)
from server.query_builder import (
    build_cells_sql,
    build_export_sql,
    build_picklist_count_sql,
    build_picklist_sql,
    build_tuples_count_sql,
    build_tuples_sql,
)

SCHEMA_FIELDS = {"date", "symbol", "volume"}
DR_SINGLE = DateRangeSingle(type="single", date="2026-03-01")
DR_RANGE = DateRangeRange(type="range", start="2026-03-01", end="2026-03-31")


class TestBuildTuplesSql:
    def test_basic_select(self) -> None:
        query = TuplesQueryBody(
            fields=[TupleFieldSpec(field="symbol")],
            paging=PagingSpec(limit=10, offset=0),
        )
        sql, params = build_tuples_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert '"symbol"' in sql
        assert "GROUP BY" in sql
        assert "LIMIT 10 OFFSET 0" in sql
        assert params == ["2026-03-01"]

    def test_date_range_filter(self) -> None:
        query = TuplesQueryBody(fields=[TupleFieldSpec(field="symbol")])
        sql, params = build_tuples_sql("trades_v1", query, DR_RANGE, SCHEMA_FIELDS)
        assert "BETWEEN ? AND ?" in sql
        assert params == ["2026-03-01", "2026-03-31"]

    def test_include_filter(self) -> None:
        query = TuplesQueryBody(
            fields=[TupleFieldSpec(field="symbol")],
            filters=[TupleFilter(field="symbol", operator="INCLUDE", values=["AAPL", "GOOG"])],
        )
        sql, params = build_tuples_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert '"symbol" IN (?, ?)' in sql
        assert "AAPL" in params
        assert "GOOG" in params

    def test_exclude_filter(self) -> None:
        query = TuplesQueryBody(
            fields=[TupleFieldSpec(field="symbol")],
            filters=[TupleFilter(field="symbol", operator="EXCLUDE", values=["TSLA"])],
        )
        sql, params = build_tuples_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "NOT IN" in sql
        assert "TSLA" in params

    def test_like_filter(self) -> None:
        query = TuplesQueryBody(
            fields=[TupleFieldSpec(field="symbol")],
            filters=[TupleFilter(field="symbol", operator="LIKE", values=["AA%"])],
        )
        sql, params = build_tuples_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert '"symbol" LIKE ?' in sql
        assert "AA%" in params

    def test_between_filter(self) -> None:
        query = TuplesQueryBody(
            fields=[TupleFieldSpec(field="volume")],
            filters=[TupleFilter(field="volume", operator="BETWEEN", values=[1000, 2000])],
        )
        sql, params = build_tuples_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert '"volume" BETWEEN ? AND ?' in sql
        assert 1000 in params
        assert 2000 in params

    def test_between_filter_needs_two_values(self) -> None:
        query = TuplesQueryBody(
            fields=[TupleFieldSpec(field="volume")],
            filters=[TupleFilter(field="volume", operator="BETWEEN", values=[1000])],
        )
        sql, params = build_tuples_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "BETWEEN" not in sql

    def test_sort_desc(self) -> None:
        query = TuplesQueryBody(fields=[TupleFieldSpec(field="symbol", sort="DESC")])
        sql, _ = build_tuples_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "DESC" in sql

    def test_empty_fields(self) -> None:
        query = TuplesQueryBody(fields=[])
        sql, params = build_tuples_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "FALSE" in sql

    def test_unknown_field_skipped(self) -> None:
        query = TuplesQueryBody(fields=[TupleFieldSpec(field="nonexistent")])
        sql, _ = build_tuples_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "FALSE" in sql

    def test_filter_on_unknown_field_skipped(self) -> None:
        query = TuplesQueryBody(
            fields=[TupleFieldSpec(field="symbol")],
            filters=[TupleFilter(field="unknown_col", operator="INCLUDE", values=["X"])],
        )
        sql, params = build_tuples_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "unknown_col" not in sql

    def test_multiple_fields(self) -> None:
        query = TuplesQueryBody(
            fields=[TupleFieldSpec(field="date"), TupleFieldSpec(field="symbol")],
            paging=PagingSpec(limit=10, offset=0),
        )
        sql, _ = build_tuples_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert '"date"' in sql
        assert '"symbol"' in sql
        assert "COUNT(*) OVER()" in sql


class TestBuildTuplesCountSql:
    def test_count_query(self) -> None:
        query = TuplesQueryBody(fields=[TupleFieldSpec(field="symbol")])
        sql, params = build_tuples_count_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "COUNT(*)" in sql
        assert "GROUP BY" in sql

    def test_count_with_no_fields(self) -> None:
        query = TuplesQueryBody(fields=[])
        sql, params = build_tuples_count_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert sql == "SELECT 0"


class TestBuildCellsSql:
    def test_basic_aggregation(self) -> None:
        query = CellsQueryBody(
            axes={
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "total_volume"}],
            },
        )
        sql, params = build_cells_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert 'SUM("volume")' in sql
        assert '"total_volume"' in sql
        assert "GROUP BY" in sql

    def test_no_axes(self) -> None:
        query = CellsQueryBody(axes={})
        sql, _ = build_cells_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "FALSE" in sql

    def test_with_filter(self) -> None:
        query = CellsQueryBody(
            axes={
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "sum_vol"}],
            },
            filters=[TupleFilter(field="symbol", operator="INCLUDE", values=["AAPL"])],
        )
        sql, params = build_cells_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert '"symbol" IN (?)' in sql
        assert "AAPL" in params

    def test_count_aggregation(self) -> None:
        query = CellsQueryBody(
            axes={
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "volume", "aggregation": "COUNT", "alias": "count_vol"}],
            },
        )
        sql, _ = build_cells_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert 'COUNT("volume")' in sql

    def test_avg_aggregation(self) -> None:
        query = CellsQueryBody(
            axes={
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "volume", "aggregation": "AVG", "alias": "avg_vol"}],
            },
        )
        sql, _ = build_cells_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert 'AVG("volume")' in sql

    def test_min_max_aggregation(self) -> None:
        query = CellsQueryBody(
            axes={
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [
                    {"field": "volume", "aggregation": "MIN", "alias": "min_vol"},
                    {"field": "volume", "aggregation": "MAX", "alias": "max_vol"},
                ],
            },
        )
        sql, _ = build_cells_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert 'MIN("volume")' in sql
        assert 'MAX("volume")' in sql

    def test_column_fields(self) -> None:
        query = CellsQueryBody(
            axes={
                "rows": [{"field": "date"}],
                "columns": [{"field": "symbol"}],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "vol"}],
            },
        )
        sql, _ = build_cells_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert '"date"' in sql
        assert '"symbol"' in sql
        assert "GROUP BY" in sql

    def test_unknown_measure_field_skipped(self) -> None:
        query = CellsQueryBody(
            axes={
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "nonexistent", "aggregation": "SUM", "alias": "x"}],
            },
        )
        sql, _ = build_cells_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "nonexistent" not in sql


class TestBuildPicklistSql:
    def test_basic_distinct(self) -> None:
        query = PicklistQueryBody(field="symbol", paging=PagingSpec(limit=50, offset=0))
        sql, params = build_picklist_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "DISTINCT" in sql
        assert '"symbol"' in sql
        assert "LIMIT 50" in sql
        assert "COUNT(*) OVER()" in sql

    def test_search_wildcard(self) -> None:
        query = PicklistQueryBody(field="symbol", search="AA*")
        sql, params = build_picklist_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "LIKE ?" in sql
        assert "AA%" in params

    def test_no_field(self) -> None:
        query = PicklistQueryBody(field=None)
        sql, _ = build_picklist_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "FALSE" in sql

    def test_with_filter(self) -> None:
        query = PicklistQueryBody(
            field="symbol",
            filters=[TupleFilter(field="symbol", operator="EXCLUDE", values=["TSLA"])],
            paging=PagingSpec(limit=100, offset=0),
        )
        sql, params = build_picklist_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "NOT IN" in sql
        assert "TSLA" in params


class TestBuildPicklistCountSql:
    def test_count_distinct(self) -> None:
        query = PicklistQueryBody(field="symbol")
        sql, _ = build_picklist_count_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "COUNT(DISTINCT" in sql

    def test_no_field(self) -> None:
        query = PicklistQueryBody(field=None)
        sql, _ = build_picklist_count_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert sql == "SELECT 0"


class TestBuildExportSql:
    def test_basic_export_with_dimensions_and_measures(self) -> None:
        query = ExportQueryBody(
            axes={
                "rows": [{"field": "symbol"}],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "total_volume"}],
            },
            max_rows=500,
        )
        sql, params, headers = build_export_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert '"symbol"' in sql
        assert 'SUM("volume")' in sql
        assert "GROUP BY" in sql
        assert "ORDER BY" in sql
        assert "LIMIT 500" in sql
        assert headers == ["symbol", "total_volume"]
        assert params == ["2026-03-01"]

    def test_date_range(self) -> None:
        query = ExportQueryBody(
            axes={"rows": [{"field": "symbol"}], "measures": []},
        )
        sql, params, headers = build_export_sql("trades_v1", query, DR_RANGE, SCHEMA_FIELDS)
        assert "BETWEEN ? AND ?" in sql
        assert params == ["2026-03-01", "2026-03-31"]

    def test_with_filter(self) -> None:
        query = ExportQueryBody(
            axes={
                "rows": [{"field": "symbol"}],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "vol"}],
            },
            filters=[TupleFilter(field="symbol", operator="INCLUDE", values=["AAPL"])],
        )
        sql, params, _ = build_export_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert '"symbol" IN (?)' in sql
        assert "AAPL" in params

    def test_max_rows_at_upper_bound(self) -> None:
        query = ExportQueryBody(
            axes={"rows": [{"field": "symbol"}], "measures": []},
            max_rows=100000,
        )
        sql, _, _ = build_export_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "LIMIT 100000" in sql

    def test_default_max_rows(self) -> None:
        query = ExportQueryBody(
            axes={"rows": [{"field": "symbol"}], "measures": []},
        )
        sql, _, _ = build_export_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "LIMIT 10000" in sql

    def test_empty_axes_exports_all_columns(self) -> None:
        query = ExportQueryBody(axes={}, max_rows=100)
        sql, params, headers = build_export_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "GROUP BY" not in sql
        assert "LIMIT 100" in sql
        assert set(headers) == {"date", "symbol", "volume"}

    def test_dimensions_only_no_group_by(self) -> None:
        query = ExportQueryBody(
            axes={"rows": [{"field": "symbol"}, {"field": "date"}], "measures": []},
        )
        sql, _, headers = build_export_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "GROUP BY" not in sql
        assert headers == ["symbol", "date"]

    def test_row_and_column_fields(self) -> None:
        query = ExportQueryBody(
            axes={
                "rows": [{"field": "date"}],
                "columns": [{"field": "symbol"}],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "vol"}],
            },
        )
        sql, _, headers = build_export_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert '"date"' in sql
        assert '"symbol"' in sql
        assert "GROUP BY" in sql
        assert headers == ["date", "symbol", "vol"]

    def test_unknown_field_skipped(self) -> None:
        query = ExportQueryBody(
            axes={
                "rows": [{"field": "nonexistent"}],
                "measures": [{"field": "volume", "aggregation": "SUM", "alias": "vol"}],
            },
        )
        sql, _, headers = build_export_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "nonexistent" not in sql
        assert headers == ["vol"]
