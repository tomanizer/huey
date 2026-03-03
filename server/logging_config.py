"""
Logging configuration for QueryService.

Supports two formats controlled by QUERYSERVICE_LOG_FORMAT:
- "text" (default): human-readable for development
- "json": structured JSON for production observability

All log records are enriched with the current request_id via RequestIdFilter.
"""

import logging
import sys

from pythonjsonlogger.json import JsonFormatter

from server.request_context import get_request_id


class RequestIdFilter(logging.Filter):
    """Inject the current correlation ID into every log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        """Attach request_id (if any) so formatters can include it."""
        record.request_id = get_request_id()  # type: ignore[attr-defined]
        return True


def setup_logging(level: str = "INFO", log_format: str = "text") -> None:
    """Configure the root logger with the specified level and format."""
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    if root.handlers:
        root.handlers.clear()

    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RequestIdFilter())

    if log_format == "json":
        formatter = JsonFormatter(
            fmt="%(asctime)s %(levelname)s %(name)s %(request_id)s %(message)s",
            rename_fields={"asctime": "timestamp", "levelname": "level"},
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    else:
        formatter = logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s [%(request_id)s]: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )

    handler.setFormatter(formatter)
    root.addHandler(handler)
