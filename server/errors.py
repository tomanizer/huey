"""
Domain exceptions and standard error response model for QueryService.

All API errors conform to a single ErrorResponse schema with a stable
machine-readable `code`, human-readable `message`, optional `request_id`,
and optional `details`.
"""

from typing import Any

from pydantic import BaseModel


class ErrorResponse(BaseModel):
    """Standard error envelope returned by all API error paths."""

    code: str
    message: str
    request_id: str | None = None
    details: dict[str, Any] | None = None


class AppError(Exception):
    """Base class for domain exceptions that map to HTTP error responses."""

    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details
        super().__init__(message)


class ValidationAppError(AppError):
    """Raised when request body contains unknown or invalid fields (422)."""

    def __init__(self, errors: list[dict[str, Any]]) -> None:
        super().__init__(
            code="VALIDATION_ERROR",
            message="Request validation failed",
            status_code=422,
            details={"errors": errors},
        )


class AggregationNotSupportedError(AppError):
    """Raised when a requested aggregation is incompatible with the field/type."""

    def __init__(self, errors: list[dict[str, Any]]) -> None:
        super().__init__(
            code="AGGREGATION_NOT_SUPPORTED",
            message="Aggregation is not supported for this request",
            status_code=422,
            details={"errors": errors},
        )


class DatasetNotFoundError(AppError):
    """Raised when a requested dataset_id is not registered in the service."""

    def __init__(self, dataset_id: str) -> None:
        super().__init__(
            code="DATASET_NOT_FOUND",
            message=f"Dataset not found: {dataset_id}",
            status_code=404,
            details={"dataset_id": dataset_id},
        )


class DatasetUnavailableError(AppError):
    """Raised when dataset metadata exists but backing table/data is unavailable."""

    def __init__(self, dataset_id: str) -> None:
        super().__init__(
            code="DATASET_UNAVAILABLE",
            message="Dataset is configured but not available for querying",
            status_code=409,
            details={"dataset_id": dataset_id},
        )


class DateRangeNotSupportedError(AppError):
    """Raised when a client supplies date_range for a dataset without a time dimension."""

    def __init__(self, dataset_id: str) -> None:
        super().__init__(
            code="DATE_RANGE_NOT_SUPPORTED",
            message=f"Dataset does not support date_range filtering: {dataset_id}",
            status_code=422,
            details={"dataset_id": dataset_id},
        )


class DatasetConfigError(AppError):
    """Raised when a dataset entry is invalid or missing required source settings."""

    def __init__(self, dataset_id: str, message: str, details: dict[str, Any] | None = None) -> None:
        payload = {"dataset_id": dataset_id}
        if details:
            payload.update(details)
        super().__init__(
            code="DATASET_CONFIG_ERROR",
            message=message,
            status_code=500,
            details=payload,
        )


class ExportNotFoundError(AppError):
    """Raised when an export job ID does not exist in the job store."""

    def __init__(self, export_id: str) -> None:
        super().__init__(
            code="EXPORT_NOT_FOUND",
            message=f"Export not found: {export_id}",
            status_code=404,
            details={"export_id": export_id},
        )


class ExportNotReadyError(AppError):
    """Raised when a caller tries to download an export that is not complete."""

    def __init__(self, export_id: str, status: str) -> None:
        super().__init__(
            code="EXPORT_NOT_READY",
            message=f"Export not ready (status: {status})",
            status_code=409,
            details={"export_id": export_id, "status": status},
        )


class ExportFileNotFoundError(AppError):
    """Raised when the export file expected on disk is missing."""

    def __init__(self, export_id: str) -> None:
        super().__init__(
            code="EXPORT_FILE_NOT_FOUND",
            message=f"Export file not found on disk: {export_id}",
            status_code=404,
            details={"export_id": export_id},
        )


class TooManyConcurrentExportsError(AppError):
    """Raised when the export concurrency cap has been exceeded."""

    def __init__(self, max_concurrent: int) -> None:
        super().__init__(
            code="TOO_MANY_EXPORTS",
            message=f"Too many concurrent exports (max {max_concurrent})",
            status_code=429,
            details={"max_concurrent": max_concurrent},
        )


class PartitionConfigError(AppError):
    """Raised when partition-native execution is requested without required config."""

    def __init__(self, details: dict[str, Any]) -> None:
        super().__init__(
            code="PARTITION_CONFIG_ERROR",
            message="Partitioned execution requires a bucket or base path",
            status_code=500,
            details=details,
        )


class PartitionNotFoundError(AppError):
    """Raised when requested partitions are missing on disk/remote storage."""

    def __init__(self, dataset_id: str, dates: list[str]) -> None:
        super().__init__(
            code="PARTITION_NOT_FOUND",
            message=f"Partitions not found for dataset {dataset_id}",
            status_code=404,
            details={"dataset_id": dataset_id, "dates": dates},
        )


class QueryTimeoutError(AppError):
    """Raised when a query exceeds the configured timeout budget."""

    def __init__(self, timeout_seconds: float) -> None:
        super().__init__(
            code="QUERY_TIMEOUT",
            message=f"Query exceeded timeout of {timeout_seconds} seconds",
            status_code=504,
            details={"timeout_seconds": timeout_seconds},
        )


class QueryCancelledError(AppError):
    """Raised when a query is cancelled due to client disconnect."""

    def __init__(self) -> None:
        super().__init__(
            code="QUERY_CANCELLED",
            message="Query cancelled because the client disconnected",
            status_code=499,
        )


class CellsWindowTooLargeError(AppError):
    """Raised when a requested cells window exceeds configured limits."""

    def __init__(self, message: str, details: dict[str, Any]) -> None:
        super().__init__(
            code="CELLS_WINDOW_TOO_LARGE",
            message=message,
            status_code=400,
            details=details,
        )


class AuthError(AppError):
    """Raised on missing or invalid API key authentication."""

    def __init__(self, message: str) -> None:
        super().__init__(
            code="AUTH_ERROR",
            message=message,
            status_code=401,
        )


class TooManyConcurrentQueriesError(AppError):
    """Raised when the in-flight query limit and queue depth are exceeded."""

    def __init__(self, max_concurrent: int, max_queue_depth: int | None) -> None:
        super().__init__(
            code="TOO_MANY_QUERIES",
            message="Query service is overloaded, please retry later",
            status_code=429,
            details={
                "max_concurrent": max_concurrent,
                "max_queue_depth": max_queue_depth,
            },
        )
