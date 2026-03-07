"""
Request/response models for QueryService API (tech spec).

All user-facing fields use Literal types and Pydantic Field constraints
so invalid requests fail fast with clear 422 errors.
"""

from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

from server.config import get_settings
from server.errors import ValidationAppError

FilterOperator = Literal["INCLUDE", "EXCLUDE", "LIKE", "BETWEEN"]
SortDirection = Literal["ASC", "DESC"]
ExportFormat = Literal["parquet", "csv", "sqlite", "duckdb"]
AggregationFunction = Literal["SUM", "COUNT", "AVG", "MIN", "MAX"]

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
                "type": "value_error.date_range_too_large",
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


# --- Common envelope ---
class ClientContext(BaseModel):
    """Optional client metadata propagated through logs and responses."""

    user_id: str | None = None
    request_id: str | None = None
    huey_version: str | None = None


# --- Shared query components ---
class TupleFieldSpec(BaseModel):
    """Dimension or measure requested in tuple queries, with sort/totals flags."""

    field: str
    derivation: str | None = None  # reserved: tech spec derivation support
    sort: SortDirection | None = None
    include_totals: bool | None = None  # reserved: tech spec totals support


class TupleFilter(BaseModel):
    """Filter expression applied to tuple/cell queries."""

    field: str
    operator: FilterOperator
    values: list[Any]


class PagingSpec(BaseModel):
    """Client paging request with bounds to protect the engine."""

    limit: int = Field(default=100, ge=1, le=MAX_PAGE_LIMIT)
    offset: int = Field(default=0, ge=0)


class WindowSpec(BaseModel):
    """Row/column window for virtualized cells requests."""

    start_index: int = Field(default=0, ge=0)
    count: int | None = Field(default=None, ge=1)


class PagingResponse(BaseModel):
    """Paging metadata returned alongside tuple/picklist responses."""

    limit: int
    offset: int
    returned: int


# --- Axes models ---
class AxisField(BaseModel):
    """A dimension field referenced in a cells or export query axis."""

    field: str


class MeasureSpec(BaseModel):
    """An aggregated measure with a required aggregation function and optional alias."""

    field: str
    aggregation: AggregationFunction = "SUM"
    alias: str | None = None


class AxesSpec(BaseModel):
    """Typed axes specification grouping row dimensions, column dimensions, and measures."""

    rows: list[AxisField] = Field(default_factory=list)
    columns: list[AxisField] = Field(default_factory=list)
    measures: list[MeasureSpec] = Field(default_factory=list)


# --- Typed query bodies ---
class TuplesQueryBody(BaseModel):
    """Body for /query/tuples supporting optional fields, filters, and paging."""

    axis: str | None = None  # reserved: tech spec multi-axis support
    fields: list[TupleFieldSpec] | None = None
    filters: list[TupleFilter] | None = None
    paging: PagingSpec | None = None


class CellsQueryBody(BaseModel):
    """Body for /query/cells, driving aggregation axes and filters."""

    rows: WindowSpec | None = None  # virtualized row window (start/count)
    columns: WindowSpec | None = None  # virtualized column window (start/count)
    axes: AxesSpec | None = None
    filters: list[TupleFilter] | None = None


class PicklistQueryBody(BaseModel):
    """Body for /query/picklist, selecting a field and optional search/paging."""

    field: str | None = None
    search: str | None = ""
    filters: list[TupleFilter] | None = None
    paging: PagingSpec | None = None


class ExportQueryBody(BaseModel):
    """Body for /export, describing export format, filters, and bounds."""

    export_type: str | None = None
    axes: AxesSpec | None = None
    filters: list[TupleFilter] | None = None
    max_rows: int = Field(default=10000, ge=1, le=MAX_EXPORT_ROWS)
    format: ExportFormat = "parquet"


# --- Request models ---
class QueryTuplesRequest(BaseModel):
    """POST /query/tuples body (envelope)."""

    dataset_id: str
    date_range: DateRange
    query: TuplesQueryBody = TuplesQueryBody()
    client_context: ClientContext | None = None


class QueryCellsRequest(BaseModel):
    """POST /query/cells body (envelope)."""

    dataset_id: str
    date_range: DateRange
    query: CellsQueryBody = CellsQueryBody()
    client_context: ClientContext | None = None


class QueryPicklistRequest(BaseModel):
    """POST /query/picklist body (envelope)."""

    dataset_id: str
    date_range: DateRange
    query: PicklistQueryBody = PicklistQueryBody()
    client_context: ClientContext | None = None


class ExportRequest(BaseModel):
    """POST /export body (envelope)."""

    dataset_id: str
    date_range: DateRange
    query: ExportQueryBody = ExportQueryBody()
    client_context: ClientContext | None = None


# --- Response models ---
class TupleItem(BaseModel):
    """Single tuple row returned by /query/tuples."""

    values: list[Any]
    grouping_id: int | None = None  # reserved: tech spec grouping sets


class TuplesResponse(BaseModel):
    """Response envelope for /query/tuples including paging metadata."""

    total_count: int
    items: list[TupleItem]
    paging: PagingResponse


class CellsResponse(BaseModel):
    """Response envelope for /query/cells."""

    cells: list[dict[str, Any]]


class PicklistResponse(BaseModel):
    """Response envelope for /query/picklist including paging metadata."""

    total_count: int
    values: list[dict[str, str]]
    paging: PagingResponse


class ExportResponse(BaseModel):
    """Response returned immediately after submitting an export job."""

    export_id: str
    status: str


class ExportStatusResponse(BaseModel):
    """Status response for polling export progress and download URL."""

    export_id: str
    status: str
    download_url: str | None = None
    row_count: int | None = None
