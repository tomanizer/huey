"""Unit tests for SQL query builder."""

from server.models import (
    CellsQueryBody,
    DateRangeRange,
    DateRangeSingle,
    PagingSpec,
    PicklistQueryBody,
    TupleFieldSpec,
    TupleFilter,
    TuplesQueryBody,
)
from server.query_builder import (
    build_cells_sql,
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

    def test_sort_desc(self) -> None:
        query = TuplesQueryBody(
            fields=[TupleFieldSpec(field="symbol", sort="DESC")],
        )
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


class TestBuildTuplesCountSql:
    def test_count_query(self) -> None:
        query = TuplesQueryBody(fields=[TupleFieldSpec(field="symbol")])
        sql, params = build_tuples_count_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "COUNT(*)" in sql
        assert "GROUP BY" in sql


class TestBuildCellsSql:
    def test_basic_aggregation(self) -> None:
        query = CellsQueryBody(
            axes={
                "rows": [{"field": "symbol"}],
                "columns": [],
                "measures": [{"field": "volume", "aggregation": "sum", "alias": "total_volume"}],
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


class TestBuildPicklistSql:
    def test_basic_distinct(self) -> None:
        query = PicklistQueryBody(field="symbol", paging=PagingSpec(limit=50, offset=0))
        sql, params = build_picklist_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "DISTINCT" in sql
        assert '"symbol"' in sql
        assert "LIMIT 50" in sql

    def test_search_wildcard(self) -> None:
        query = PicklistQueryBody(field="symbol", search="AA*")
        sql, params = build_picklist_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "LIKE ?" in sql
        assert "AA%" in params

    def test_no_field(self) -> None:
        query = PicklistQueryBody(field=None)
        sql, _ = build_picklist_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "FALSE" in sql


class TestBuildPicklistCountSql:
    def test_count_distinct(self) -> None:
        query = PicklistQueryBody(field="symbol")
        sql, _ = build_picklist_count_sql("trades_v1", query, DR_SINGLE, SCHEMA_FIELDS)
        assert "COUNT(DISTINCT" in sql
