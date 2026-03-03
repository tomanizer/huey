"""Runtime guardrails for supported Python versions."""

import sys
from collections.abc import Sequence

MIN_PYTHON = (3, 11)


def ensure_supported_python(version_info: Sequence[int] | None = None) -> None:
    """Raise RuntimeError when running on an unsupported Python version."""
    current = version_info if version_info is not None else sys.version_info
    current_major_minor = (int(current[0]), int(current[1]))
    if current_major_minor < MIN_PYTHON:
        raise RuntimeError(
            "QueryService requires Python 3.11+; "
            f"detected {current_major_minor[0]}.{current_major_minor[1]}"
        )
