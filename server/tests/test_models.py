"""Unit tests for typed Pydantic request/response models."""

import pytest
from pydantic import ValidationError

from server.config import get_settings
from server.models import (
    AxesSpec,
    AxisField,
    CellsQueryBody,
    DateRangeRange,
    DateRangeSingle,
    ExportQueryBody,
    ExportRequest,
    MeasureSpec,
    PagingResponse,
    PagingSpec,
    PicklistQueryBody,
    QueryCellsRequest,
    QueryPicklistRequest,
    QueryTuplesRequest,
    TupleFieldSpec,
    TupleFilter,
    TuplesQueryBody,
)


class TestDateRangeSingle:
    def test_valid(self) -> None:
        dr = DateRangeSingle(type="single", date="2026-03-01")
        assert dr.date == "2026-03-01"

    def test_bad_format(self) -> None:
        with pytest.raises(ValidationError, match="YYYY-MM-DD"):
            DateRangeSingle(type="single", date="03-01-2026")

    def test_empty_date(self) -> None:
        with pytest.raises(ValidationError, match="YYYY-MM-DD"):
            DateRangeSingle(type="single", date="")

    def test_invalid_calendar_day(self) -> None:
        with pytest.raises(ValidationError, match="YYYY-MM-DD"):
            DateRangeSingle(type="single", date="2026-02-30")

    def test_invalid_calendar_month(self) -> None:
        with pytest.raises(ValidationError, match="YYYY-MM-DD"):
            DateRangeSingle(type="single", date="2026-13-01")

    def test_wrong_type_literal(self) -> None:
        with pytest.raises(ValidationError):
            DateRangeSingle(type="range", date="2026-03-01")


class TestDateRangeRange:
    def test_valid(self) -> None:
        dr = DateRangeRange(type="range", start="2026-01-01", end="2026-03-01")
        assert dr.start == "2026-01-01"
        assert dr.end == "2026-03-01"

    def test_equal_dates(self) -> None:
        dr = DateRangeRange(type="range", start="2026-03-01", end="2026-03-01")
        assert dr.start == dr.end

    def test_start_after_end(self) -> None:
        with pytest.raises(ValidationError, match="start must be <= end"):
            DateRangeRange(type="range", start="2026-12-01", end="2026-01-01")

    def test_bad_start_format(self) -> None:
        with pytest.raises(ValidationError, match="YYYY-MM-DD"):
            DateRangeRange(type="range", start="bad", end="2026-03-01")

    def test_bad_end_format(self) -> None:
        with pytest.raises(ValidationError, match="YYYY-MM-DD"):
            DateRangeRange(type="range", start="2026-01-01", end="bad")

    def test_bad_start_calendar_date(self) -> None:
        with pytest.raises(ValidationError, match="YYYY-MM-DD"):
            DateRangeRange(type="range", start="2026-02-30", end="2026-03-01")

    def test_bad_end_calendar_date(self) -> None:
        with pytest.raises(ValidationError, match="YYYY-MM-DD"):
            DateRangeRange(type="range", start="2026-03-01", end="2026-13-01")

    def test_span_at_limit(self, monkeypatch) -> None:
        monkeypatch.setenv("QUERYSERVICE_MAX_DATE_RANGE_DAYS", "2")
        get_settings.cache_clear()
        try:
            dr = DateRangeRange(type="range", start="2026-03-01", end="2026-03-02")
        finally:
            get_settings.cache_clear()
        assert dr.start == "2026-03-01"
        assert dr.end == "2026-03-02"

    def test_span_over_limit(self, monkeypatch) -> None:
        monkeypatch.setenv("QUERYSERVICE_MAX_DATE_RANGE_DAYS", "2")
        get_settings.cache_clear()
        try:
            with pytest.raises(ValidationError) as exc_info:
                DateRangeRange(type="range", start="2026-03-01", end="2026-03-03")
        finally:
            get_settings.cache_clear()
        errors = exc_info.value.errors()
        assert errors[0]["type"] == "date_range_too_large"
        assert errors[0]["ctx"] == {"requested_days": 3, "max_days": 2}


class TestTupleFieldSpec:
    def test_valid_sort_asc(self) -> None:
        f = TupleFieldSpec(field="symbol", sort="ASC")
        assert f.sort == "ASC"

    def test_valid_sort_desc(self) -> None:
        f = TupleFieldSpec(field="symbol", sort="DESC")
        assert f.sort == "DESC"

    def test_sort_none_default(self) -> None:
        f = TupleFieldSpec(field="symbol")
        assert f.sort is None

    def test_invalid_sort_rejected(self) -> None:
        with pytest.raises(ValidationError, match="sort"):
            TupleFieldSpec(field="symbol", sort="RANDOM")


class TestTupleFilter:
    def test_valid_operators(self) -> None:
        for op in ("INCLUDE", "EXCLUDE", "LIKE", "BETWEEN"):
            f = TupleFilter(field="symbol", operator=op, values=["x"])
            assert f.operator == op

    def test_invalid_operator_rejected(self) -> None:
        with pytest.raises(ValidationError, match="operator"):
            TupleFilter(field="symbol", operator="INVALID", values=["x"])

    def test_lowercase_operator_rejected(self) -> None:
        with pytest.raises(ValidationError, match="operator"):
            TupleFilter(field="symbol", operator="include", values=["x"])


class TestPagingSpec:
    def test_defaults(self) -> None:
        ps = PagingSpec()
        assert ps.limit == 100
        assert ps.offset == 0

    def test_valid_bounds(self) -> None:
        ps = PagingSpec(limit=1, offset=0)
        assert ps.limit == 1
        ps = PagingSpec(limit=10000, offset=999)
        assert ps.limit == 10000

    def test_limit_zero_rejected(self) -> None:
        with pytest.raises(ValidationError, match="limit"):
            PagingSpec(limit=0)

    def test_limit_negative_rejected(self) -> None:
        with pytest.raises(ValidationError, match="limit"):
            PagingSpec(limit=-1)

    def test_limit_exceeds_max_rejected(self) -> None:
        with pytest.raises(ValidationError, match="limit"):
            PagingSpec(limit=10001)

    def test_offset_negative_rejected(self) -> None:
        with pytest.raises(ValidationError, match="offset"):
            PagingSpec(offset=-1)


class TestExportQueryBody:
    def test_defaults(self) -> None:
        eq = ExportQueryBody()
        assert eq.max_rows == 10000
        assert eq.format == "parquet"

    def test_valid_max_rows(self) -> None:
        eq = ExportQueryBody(max_rows=1)
        assert eq.max_rows == 1
        eq = ExportQueryBody(max_rows=100000)
        assert eq.max_rows == 100000

    def test_max_rows_zero_rejected(self) -> None:
        with pytest.raises(ValidationError, match="max_rows"):
            ExportQueryBody(max_rows=0)

    def test_max_rows_negative_rejected(self) -> None:
        with pytest.raises(ValidationError, match="max_rows"):
            ExportQueryBody(max_rows=-1)

    def test_max_rows_exceeds_limit_rejected(self) -> None:
        with pytest.raises(ValidationError, match="max_rows"):
            ExportQueryBody(max_rows=100001)

    def test_invalid_format_rejected(self) -> None:
        with pytest.raises(ValidationError, match="format"):
            ExportQueryBody(format="xlsx")

    @pytest.mark.parametrize("fmt", ["csv", "parquet", "sqlite", "duckdb"])
    def test_supported_formats_accepted(self, fmt: str) -> None:
        eq = ExportQueryBody(format=fmt)
        assert eq.format == fmt


class TestQueryTuplesRequest:
    def test_valid_full(self) -> None:
        req = QueryTuplesRequest(
            dataset_id="trades_v1",
            date_range={"type": "single", "date": "2026-03-01"},
            query={"axis": "rows", "fields": [{"field": "symbol"}], "paging": {"limit": 10, "offset": 0}},
        )
        assert req.dataset_id == "trades_v1"
        assert isinstance(req.date_range, DateRangeSingle)
        assert isinstance(req.query, TuplesQueryBody)
        assert req.query.axis == "rows"
        assert req.query.paging.limit == 10

    def test_empty_query(self) -> None:
        req = QueryTuplesRequest(
            dataset_id="trades_v1",
            date_range={"type": "single", "date": "2026-03-01"},
            query={},
        )
        assert req.query.axis is None
        assert req.query.paging is None

    def test_default_query(self) -> None:
        req = QueryTuplesRequest(
            dataset_id="trades_v1",
            date_range={"type": "single", "date": "2026-03-01"},
        )
        assert req.query.axis is None

    def test_missing_date_range(self) -> None:
        with pytest.raises(ValidationError):
            QueryTuplesRequest(dataset_id="trades_v1", query={})


class TestQueryCellsRequest:
    def test_valid_full(self) -> None:
        req = QueryCellsRequest(
            dataset_id="trades_v1",
            date_range={"type": "range", "start": "2026-01-01", "end": "2026-03-01"},
            query={
                "rows": {"start_index": 0, "count": 10},
                "columns": {"start_index": 0, "count": 5},
                "axes": {"rows": [], "columns": [], "measures": []},
                "filters": [],
            },
        )
        assert isinstance(req.query, CellsQueryBody)
        assert req.query.rows is not None
        assert req.query.rows.start_index == 0
        assert req.query.rows.count == 10


class TestQueryPicklistRequest:
    def test_valid_full(self) -> None:
        req = QueryPicklistRequest(
            dataset_id="trades_v1",
            date_range={"type": "single", "date": "2026-03-01"},
            query={"field": "symbol", "search": "AA*", "filters": [], "paging": {"limit": 50, "offset": 0}},
        )
        assert isinstance(req.query, PicklistQueryBody)
        assert req.query.field == "symbol"
        assert req.query.search == "AA*"
        assert req.query.paging.limit == 50


class TestExportRequest:
    def test_valid_full(self) -> None:
        req = ExportRequest(
            dataset_id="trades_v1",
            date_range={"type": "single", "date": "2026-03-01"},
            query={"export_type": "pivot_results", "axes": {}, "filters": [], "max_rows": 1000, "format": "csv"},
        )
        assert isinstance(req.query, ExportQueryBody)
        assert req.query.export_type == "pivot_results"
        assert req.query.max_rows == 1000

    def test_defaults(self) -> None:
        req = ExportRequest(
            dataset_id="trades_v1",
            date_range={"type": "single", "date": "2026-03-01"},
        )
        assert req.query.max_rows == 10000
        assert req.query.format == "parquet"


class TestAxesModels:
    def test_axis_field_valid(self) -> None:
        af = AxisField(field="symbol")
        assert af.field == "symbol"

    def test_axis_field_missing_field_raises(self) -> None:
        with pytest.raises(ValidationError):
            AxisField()

    def test_measure_spec_defaults(self) -> None:
        m = MeasureSpec(field="volume")
        assert m.aggregation == "SUM"
        assert m.alias is None

    def test_measure_spec_all_aggregations(self) -> None:
        for agg in ("SUM", "COUNT", "AVG", "MIN", "MAX"):
            m = MeasureSpec(field="volume", aggregation=agg)
            assert m.aggregation == agg

    def test_measure_spec_invalid_aggregation_raises(self) -> None:
        with pytest.raises(ValidationError):
            MeasureSpec(field="volume", aggregation="INVALID")

    def test_measure_spec_with_alias(self) -> None:
        m = MeasureSpec(field="volume", aggregation="SUM", alias="vol")
        assert m.alias == "vol"

    def test_axes_spec_defaults(self) -> None:
        axes = AxesSpec()
        assert axes.rows == []
        assert axes.columns == []
        assert axes.measures == []

    def test_axes_spec_from_dict(self) -> None:
        axes = AxesSpec(
            rows=[{"field": "symbol"}],
            columns=[],
            measures=[{"field": "volume", "aggregation": "SUM", "alias": "v"}],
        )
        assert len(axes.rows) == 1
        assert isinstance(axes.rows[0], AxisField)
        assert axes.rows[0].field == "symbol"
        assert isinstance(axes.measures[0], MeasureSpec)
        assert axes.measures[0].alias == "v"

    def test_cells_query_body_axes_coerced(self) -> None:
        body = CellsQueryBody(axes={"rows": [{"field": "symbol"}], "measures": [{"field": "volume"}]})
        assert isinstance(body.axes, AxesSpec)
        assert body.axes.rows[0].field == "symbol"
        assert body.axes.measures[0].aggregation == "SUM"

    def test_export_query_body_axes_coerced(self) -> None:
        body = ExportQueryBody(axes={"rows": [{"field": "date"}], "measures": [{"field": "volume", "aggregation": "COUNT"}]})
        assert isinstance(body.axes, AxesSpec)
        assert body.axes.measures[0].aggregation == "COUNT"


class TestPagingModels:
    def test_paging_spec_defaults(self) -> None:
        ps = PagingSpec()
        assert ps.limit == 100
        assert ps.offset == 0

    def test_paging_response(self) -> None:
        pr = PagingResponse(limit=10, offset=5, returned=3)
        assert pr.returned == 3
