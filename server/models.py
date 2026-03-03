"""
Request/response models for QueryService API (tech spec).
"""

import re
from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator, model_validator

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# --- Date range (envelope) ---
class DateRangeSingle(BaseModel):
    type: Literal["single"]
    date: str

    @field_validator("date")
    @classmethod
    def validate_date_format(cls, v: str) -> str:
        if not _DATE_RE.match(v):
            raise ValueError("Invalid date format, use YYYY-MM-DD")
        return v


class DateRangeRange(BaseModel):
    type: Literal["range"]
    start: str
    end: str

    @field_validator("start", "end")
    @classmethod
    def validate_date_format(cls, v: str) -> str:
        if not _DATE_RE.match(v):
            raise ValueError("Invalid date format, use YYYY-MM-DD")
        return v

    @model_validator(mode="after")
    def check_start_before_end(self) -> "DateRangeRange":
        if self.start > self.end:
            raise ValueError("Date range start must be <= end")
        return self


DateRange = Annotated[
    Union[DateRangeSingle, DateRangeRange],
    Field(discriminator="type"),
]


# --- Common envelope ---
class ClientContext(BaseModel):
    user_id: Optional[str] = None
    request_id: Optional[str] = None
    huey_version: Optional[str] = None


# --- Shared query components ---
class TupleFieldSpec(BaseModel):
    field: str
    derivation: Optional[str] = None  # reserved: tech spec derivation support
    sort: Optional[str] = None
    include_totals: Optional[bool] = None  # reserved: tech spec totals support


class TupleFilter(BaseModel):
    field: str
    operator: str
    values: list[Any]


class PagingSpec(BaseModel):
    limit: int = 100
    offset: int = 0


class PagingResponse(BaseModel):
    limit: int
    offset: int
    returned: int


# --- Typed query bodies ---
class TuplesQueryBody(BaseModel):
    axis: Optional[str] = None  # reserved: tech spec multi-axis support
    fields: Optional[list[TupleFieldSpec]] = None
    filters: Optional[list[TupleFilter]] = None
    paging: Optional[PagingSpec] = None


class CellsQueryBody(BaseModel):
    rows: Optional[dict[str, int]] = None  # reserved: tech spec virtualized paging
    columns: Optional[dict[str, int]] = None  # reserved: tech spec virtualized paging
    axes: Optional[dict[str, Any]] = None
    filters: Optional[list[TupleFilter]] = None


class PicklistQueryBody(BaseModel):
    field: Optional[str] = None
    search: Optional[str] = ""
    filters: Optional[list[TupleFilter]] = None
    paging: Optional[PagingSpec] = None


class ExportQueryBody(BaseModel):
    export_type: Optional[str] = None
    axes: Optional[dict[str, Any]] = None
    filters: Optional[list[TupleFilter]] = None
    max_rows: Optional[int] = 10000
    format: Optional[str] = "csv"


# --- Request models ---
class QueryTuplesRequest(BaseModel):
    """POST /query/tuples body (envelope)."""

    dataset_id: str
    date_range: DateRange
    query: TuplesQueryBody = TuplesQueryBody()
    client_context: Optional[ClientContext] = None


class QueryCellsRequest(BaseModel):
    """POST /query/cells body (envelope)."""

    dataset_id: str
    date_range: DateRange
    query: CellsQueryBody = CellsQueryBody()
    client_context: Optional[ClientContext] = None


class QueryPicklistRequest(BaseModel):
    """POST /query/picklist body (envelope)."""

    dataset_id: str
    date_range: DateRange
    query: PicklistQueryBody = PicklistQueryBody()
    client_context: Optional[ClientContext] = None


class ExportRequest(BaseModel):
    """POST /export body (envelope)."""

    dataset_id: str
    date_range: DateRange
    query: ExportQueryBody = ExportQueryBody()
    client_context: Optional[ClientContext] = None


# --- Response models ---
class TupleItem(BaseModel):
    values: list[Any]
    grouping_id: Optional[int] = None  # reserved: tech spec grouping sets


class TuplesResponse(BaseModel):
    total_count: int
    items: list[TupleItem]
    paging: PagingResponse


class CellsResponse(BaseModel):
    cells: list[dict[str, Any]]


class PicklistResponse(BaseModel):
    total_count: int
    values: list[dict[str, str]]
    paging: PagingResponse


class ExportResponse(BaseModel):
    export_id: str
    status: str


class ExportStatusResponse(BaseModel):
    export_id: str
    status: str
    download_url: Optional[str] = None
