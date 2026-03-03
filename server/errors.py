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


class DatasetNotFoundError(AppError):
    """Raised when a requested dataset_id is not registered in the service."""

    def __init__(self, dataset_id: str) -> None:
        super().__init__(
            code="DATASET_NOT_FOUND",
            message=f"Dataset not found: {dataset_id}",
            status_code=404,
            details={"dataset_id": dataset_id},
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


class CellsWindowTooLargeError(AppError):
    """Raised when requested cells window exceeds configured bounds."""

    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(
            code="CELLS_WINDOW_TOO_LARGE",
            message=message,
            status_code=400,
            details=details,
        )
