"""
Request/response models for QueryService API (tech spec).

All user-facing fields use Literal types and Pydantic Field constraints
so invalid requests fail fast with clear 422 errors.
"""

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

FilterOperator = Literal["INCLUDE", "EXCLUDE", "LIKE", "BETWEEN"]
SortDirection = Literal["ASC", "DESC"]
ExportFormat = Literal["csv"]

MAX_PAGE_LIMIT = 10000
MAX_EXPORT_ROWS = 100000


# --- Date range (envelope) ---
class DateRangeSingle(BaseModel):
    """Single-day date range used to scope queries."""

    type: Literal["single"]
    date: str

    @field_validator("date")
    @classmethod
    def validate_date_format(cls, v: str) -> str:
        """Ensure date strings follow YYYY-MM-DD."""
        if not _DATE_RE.match(v):
            raise ValueError("Invalid date format, use YYYY-MM-DD")
        return v


class DateRangeRange(BaseModel):
    """Inclusive start/end date range used to scope queries."""

    type: Literal["range"]
    start: str
    end: str

    @field_validator("start", "end")
    @classmethod
    def validate_date_format(cls, v: str) -> str:
        """Ensure start/end date strings follow YYYY-MM-DD."""
        if not _DATE_RE.match(v):
            raise ValueError("Invalid date format, use YYYY-MM-DD")
        return v

    @model_validator(mode="after")
    def check_start_before_end(self) -> "DateRangeRange":
        """Validate that the range start is not after the end."""
        if self.start > self.end:
            raise ValueError("Date range start must be <= end")
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


class PagingResponse(BaseModel):
    """Paging metadata returned alongside tuple/picklist responses."""

    limit: int
    offset: int
    returned: int


# --- Typed query bodies ---
class TuplesQueryBody(BaseModel):
    """Body for /query/tuples supporting optional fields, filters, and paging."""

    axis: str | None = None  # reserved: tech spec multi-axis support
    fields: list[TupleFieldSpec] | None = None
    filters: list[TupleFilter] | None = None
    paging: PagingSpec | None = None


class CellsQueryBody(BaseModel):
    """Body for /query/cells, driving aggregation axes and filters."""

    rows: dict[str, int] | None = None  # reserved: tech spec virtualized paging
    columns: dict[str, int] | None = None  # reserved: tech spec virtualized paging
    axes: dict[str, Any] | None = None
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
    axes: dict[str, Any] | None = None
    filters: list[TupleFilter] | None = None
    max_rows: int = Field(default=10000, ge=1, le=MAX_EXPORT_ROWS)
    format: ExportFormat = "csv"


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
