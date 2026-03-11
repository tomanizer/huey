"""
Request/response models for QueryService API (tech spec).

All user-facing fields use Literal types and Pydantic Field constraints
so invalid requests fail fast with clear 422 errors.
"""

from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

from server.config import get_settings
from server.errors import ValidationAppError

FilterOperator = Literal[
    "include",
    "exclude",
    "like",
    "between",
    "gt",
    "gte",
    "lt",
    "lte",
    "is_null",
    "not_null",
]
SortDirection = Literal["ASC", "DESC"]
ExportFormat = Literal["parquet", "csv", "sqlite", "duckdb", "csv_with_bom", "ndjson"]
AggregationFunction = Literal[
    "sum",
    "avg",
    "min",
    "max",
    "count",
    "distinct_count",
    "median",
    "mode",
    "stdev",
    "variance",
    "geomean",
    "entropy",
    "kurtosis",
    "skewness",
    "mad",
    "and",
    "or",
    "count_if_true",
    "count_if_false",
    "list",
    "unique_list",
    "first",
    "last",
    "histogram",
]

MAX_PAGE_LIMIT = 10000
MAX_EXPORT_ROWS = 100000


def _parse_iso_date(value: str) -> str:
    """Validate strict calendar date strings in YYYY-MM-DD format."""
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("Invalid date, use real YYYY-MM-DD date") from exc
    if parsed.isoformat() != value:
        raise ValueError("Invalid date, use real YYYY-MM-DD date")
    return value


class DateRangeSpanLimitError(ValueError):
    """Raised when an inclusive date range exceeds the configured span limit."""

    def __init__(self, requested_days: int, max_days: int) -> None:
        self.requested_days = requested_days
        self.max_days = max_days
        super().__init__(
            f"Date range spans {requested_days} day(s), exceeds configured max of {max_days}"
        )


def date_range_span_days(date_range: Any) -> int | None:
    """Return inclusive day span for a date_range payload or model."""
    dtype = getattr(date_range, "type", None)
    if dtype is None and isinstance(date_range, dict):
        dtype = date_range.get("type")

    if dtype == "single":
        value = getattr(date_range, "date", None) if not isinstance(date_range, dict) else date_range.get("date")
        return 1 if isinstance(value, str) and value else None

    if dtype == "range":
        start = getattr(date_range, "start", None) if not isinstance(date_range, dict) else date_range.get("start")
        end = getattr(date_range, "end", None) if not isinstance(date_range, dict) else date_range.get("end")
        if not (isinstance(start, str) and isinstance(end, str) and start and end):
            return None
        start_date = date.fromisoformat(start)
        end_date = date.fromisoformat(end)
        return (end_date - start_date).days + 1

    return None


def validate_date_range_span(date_range: Any, max_days: int) -> int | None:
    """Validate the inclusive span of a date range against a configured max."""
    requested_days = date_range_span_days(date_range)
    if requested_days is not None and requested_days > max_days:
        raise DateRangeSpanLimitError(requested_days, max_days)
    return requested_days


def raise_date_range_validation_error(exc: DateRangeSpanLimitError) -> None:
    """Raise a standard 422 ValidationAppError for an oversized date range."""
    raise ValidationAppError(
        [
            {
                "loc": ["body", "date_range"],
                "msg": str(exc),
                "type": "date_range_too_large",
                "ctx": {
                    "requested_days": exc.requested_days,
                    "max_days": exc.max_days,
                },
            }
        ]
    ) from exc


# --- Date range (envelope) ---
class DateRangeSingle(BaseModel):
    """Single-day date range used to scope queries."""

    type: Literal["single"]
    date: str

    @field_validator("date")
    @classmethod
    def validate_date_format(cls, v: str) -> str:
        """Ensure date strings follow real calendar dates in YYYY-MM-DD."""
        return _parse_iso_date(v)


class DateRangeRange(BaseModel):
    """Inclusive start/end date range used to scope queries."""

    type: Literal["range"]
    start: str
    end: str

    @field_validator("start", "end")
    @classmethod
    def validate_date_format(cls, v: str) -> str:
        """Ensure start/end strings are real calendar dates in YYYY-MM-DD."""
        return _parse_iso_date(v)

    @model_validator(mode="after")
    def check_start_before_end(self) -> "DateRangeRange":
        """Validate that the range start is not after the end."""
        if date.fromisoformat(self.start) > date.fromisoformat(self.end):
            raise ValueError("Date range start must be <= end")
        try:
            validate_date_range_span(self, get_settings().max_date_range_days)
        except DateRangeSpanLimitError as exc:
            raise PydanticCustomError(
                "date_range_too_large",
                "Date range spans {requested_days} day(s), exceeds configured max of {max_days}",
                {"requested_days": exc.requested_days, "max_days": exc.max_days},
            ) from exc
        return self


DateRange = Annotated[
    DateRangeSingle | DateRangeRange,
    Field(discriminator="type"),
]


# --- Shared query components ---
class TupleFieldSpec(BaseModel):
    """Dimension or measure requested in tuple queries, with sort/totals flags."""

    field: str
    derivation: str | None = None
    alias: str | None = None
    sort: SortDirection | None = None
    include_totals: bool | None = None  # reserved: tech spec totals support

    @field_validator("derivation", mode="before")
    @classmethod
    def normalize_derivation(cls, value: str | None) -> str | None:
        if isinstance(value, str):
            return value.lower()
        return value


class TupleFilter(BaseModel):
    """Filter expression applied to tuple/cell queries."""

    field: str
    operator: FilterOperator
    values: list[Any] = Field(default_factory=list)

    @field_validator("operator", mode="before")
    @classmethod
    def normalize_operator(cls, value: str) -> str:
        if isinstance(value, str):
            return value.lower()
        return value

    @model_validator(mode="after")
    def validate_operator_values(self) -> "TupleFilter":
        operator = self.operator
        value_count = len(self.values)

        if operator in ("is_null", "not_null"):
            if value_count != 0:
                raise PydanticCustomError(
                    "filter_invalid",
                    "Operator {operator} does not accept values",
                    {"operator": operator},
                )
            return self

        if operator in ("gt", "gte", "lt", "lte", "like"):
            if value_count != 1:
                raise PydanticCustomError(
                    "filter_invalid",
                    "Operator {operator} requires exactly 1 value",
                    {"operator": operator, "expected_values": 1, "actual_values": value_count},
                )
            return self

        if operator == "between":
            if value_count != 2:
                raise PydanticCustomError(
                    "filter_invalid",
                    "Operator between requires exactly 2 values",
                    {"operator": operator, "expected_values": 2, "actual_values": value_count},
                )
            return self

        if operator in ("include", "exclude"):
            if value_count < 1 or value_count > 1000:
                raise PydanticCustomError(
                    "filter_invalid",
                    "Operator {operator} requires between 1 and 1000 values",
                    {"operator": operator, "min_values": 1, "max_values": 1000, "actual_values": value_count},
                )
            return self

        return self


class PagingSpec(BaseModel):
    """Client paging request with bounds to protect the engine."""

    limit: int = Field(default=100, ge=1, le=MAX_PAGE_LIMIT)
    offset: int = Field(default=0, ge=0)


class WindowPagingSpec(BaseModel):
    """Offset/limit window used by v1 cells requests."""

    limit: int = Field(default=100, ge=1, le=MAX_PAGE_LIMIT)
    offset: int = Field(default=0, ge=0)


class WindowSpec(BaseModel):
    """Row/column window for virtualized cells requests."""

    start_index: int = Field(default=0, ge=0)
    count: int | None = Field(default=None, ge=1)


class CellsWindowRequest(BaseModel):
    """Top-level cells window request for row/column pagination."""

    rows: WindowPagingSpec | None = None
    columns: WindowPagingSpec | None = None


class PagingResponse(BaseModel):
    """Paging metadata returned alongside tuple/picklist responses."""

    limit: int
    offset: int
    returned: int


class MetaResponse(BaseModel):
    """Common query execution metadata returned by v1 query endpoints."""

    execution_ms: float
    cache_status: str
    request_id: str | None = None


# --- Axes models ---
class AxisField(BaseModel):
    """A dimension field referenced in a cells or export query axis."""

    field: str
    derivation: str | None = None
    alias: str | None = None

    @field_validator("derivation", mode="before")
    @classmethod
    def normalize_derivation(cls, value: str | None) -> str | None:
        if isinstance(value, str):
            return value.lower()
        return value


class MeasureSpec(BaseModel):
    """An aggregated measure with a required aggregation function and optional alias."""

    field: str
    aggregation: AggregationFunction = "sum"
    alias: str | None = None
    sort_by: str | None = None

    @field_validator("aggregation", mode="before")
    @classmethod
    def normalize_aggregation(cls, value: str) -> str:
        if isinstance(value, str):
            return value.lower()
        return value

    @model_validator(mode="after")
    def validate_sort_by(self) -> "MeasureSpec":
        if self.aggregation == "histogram":
            raise PydanticCustomError(
                "aggregation_not_supported",
                "Aggregation histogram is not supported by the API response format",
                {"aggregation": "histogram"},
            )
        if self.aggregation in ("first", "last"):
            if not self.sort_by:
                raise PydanticCustomError(
                    "sort_by_required",
                    "Aggregation {aggregation} requires sort_by",
                    {"aggregation": self.aggregation},
                )
        elif self.sort_by is not None:
            raise PydanticCustomError(
                "sort_by_not_supported",
                "Aggregation {aggregation} does not support sort_by",
                {"aggregation": self.aggregation},
            )
        return self


class AxesSpec(BaseModel):
    """Typed axes specification grouping row dimensions, column dimensions, and measures."""

    rows: list[AxisField] = Field(default_factory=list)
    columns: list[AxisField] = Field(default_factory=list)
    measures: list[MeasureSpec] = Field(default_factory=list)


# --- Typed query bodies ---
class TuplesQueryBody(BaseModel):
    """Body for /api/v1/datasets/{dataset_id}/query/tuples."""

    axis: str | None = None  # reserved: tech spec multi-axis support
    fields: list[TupleFieldSpec] | None = None
    filters: list[TupleFilter] | None = None
    paging: PagingSpec | None = None


class CellsQueryBody(BaseModel):
    """Body for /api/v1/datasets/{dataset_id}/query/cells."""

    rows: WindowSpec | None = None  # virtualized row window (start/count)
    columns: WindowSpec | None = None  # virtualized column window (start/count)
    axes: AxesSpec | None = None
    filters: list[TupleFilter] | None = None


class PicklistQueryBody(BaseModel):
    """Body for /api/v1/datasets/{dataset_id}/query/picklist."""

    field: str | None = None
    derivation: str | None = None
    alias: str | None = None
    search: str | None = ""
    filters: list[TupleFilter] | None = None
    paging: PagingSpec | None = None


class ExportQueryBody(BaseModel):
    """Body for export submission requests."""

    export_type: str | None = None
    axes: AxesSpec | None = None
    filters: list[TupleFilter] | None = None
    max_rows: int = Field(default=10000, ge=1, le=MAX_EXPORT_ROWS)
    format: ExportFormat = "parquet"


# --- Request models ---
class QueryTuplesRequest(BaseModel):
    """POST /api/v1/datasets/{dataset_id}/query/tuples body."""

    model_config = ConfigDict(extra="forbid")

    date_range: DateRange | None = None
    fields: list[TupleFieldSpec] | None = None
    filters: list[TupleFilter] | None = None
    paging: PagingSpec | None = None

    @model_validator(mode="after")
    def require_fields(self) -> "QueryTuplesRequest":
        if not self.fields:
            raise ValueError("fields must include at least one item")
        return self


class QueryCellsRequest(BaseModel):
    """POST /api/v1/datasets/{dataset_id}/query/cells body."""

    model_config = ConfigDict(extra="forbid")

    date_range: DateRange | None = None
    axes: AxesSpec | None = None
    filters: list[TupleFilter] | None = None
    window: CellsWindowRequest | None = None

    @model_validator(mode="after")
    def require_axes(self) -> "QueryCellsRequest":
        if self.axes is None:
            raise ValueError("axes is required")
        return self


class QueryPicklistRequest(BaseModel):
    """POST /api/v1/datasets/{dataset_id}/query/members body."""

    model_config = ConfigDict(extra="forbid")

    date_range: DateRange | None = None
    field: str | None = None
    derivation: str | None = None
    alias: str | None = None
    search: str | None = ""
    filters: list[TupleFilter] | None = None
    paging: PagingSpec | None = None

    @model_validator(mode="after")
    def require_field(self) -> "QueryPicklistRequest":
        if not self.field:
            raise ValueError("field is required")
        return self


class ExportRequest(BaseModel):
    """Internal export request model including the dataset identifier."""

    dataset_id: str
    date_range: DateRange
    query: ExportQueryBody = ExportQueryBody()


class ExportSubmitRequest(BaseModel):
    """Request body for POST /api/v1/datasets/{dataset_id}/exports."""

    model_config = ConfigDict(extra="forbid")

    date_range: DateRange
    query: ExportQueryBody = ExportQueryBody()


# --- Response models ---
class TupleItem(BaseModel):
    """Single tuple row returned by the v1 tuples endpoint."""

    model_config = ConfigDict(extra="allow")

    grouping_id: int | None = None  # reserved: tech spec grouping sets


class TuplesResponse(BaseModel):
    """Response envelope for the v1 tuples endpoint."""

    total_count: int
    items: list[TupleItem]
    paging: PagingResponse
    meta: MetaResponse


class CellsResponse(BaseModel):
    """Response envelope for the v1 cells endpoint."""

    rows: list[dict[str, Any]]
    columns: list[dict[str, Any]]
    cells: list[dict[str, Any]]
    window: dict[str, Any]
    meta: MetaResponse


class MemberItem(BaseModel):
    """Single member row returned by the v1 members endpoint."""

    value: Any
    count: int


class PicklistResponse(BaseModel):
    """Response envelope for the v1 members endpoint."""

    field: str
    total_count: int
    items: list[MemberItem]
    paging: PagingResponse
    meta: MetaResponse


class ExportLinks(BaseModel):
    """HATEOAS links for export resources."""

    self: str
    file: str


class ExportResponse(BaseModel):
    """Response returned immediately after submitting an export job."""

    export_id: str
    dataset_id: str
    status: str
    links: ExportLinks


class ExportListItem(BaseModel):
    """Single export item returned by GET /api/v1/exports."""

    export_id: str
    dataset_id: str
    status: str
    format: ExportFormat
    row_count: int | None = None
    size_bytes: int | None = None
    created_at: str
    expires_at: str
    links: ExportLinks


class ExportListResponse(BaseModel):
    """Cursor-paginated export listing."""

    items: list[ExportListItem]
    cursor: str | None = None


class ExportStatusResponse(BaseModel):
    """Status response for polling export progress and download URL."""

    export_id: str
    dataset_id: str
    status: str
    format: ExportFormat
    created_at: str
    expires_at: str
    download_url: str | None = None
    row_count: int | None = None
    size_bytes: int | None = None
    completed_at: str | None = None
    progress_pct: int | None = None
    links: ExportLinks
