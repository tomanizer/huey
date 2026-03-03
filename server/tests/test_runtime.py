"""Tests for runtime Python version guardrails."""

import pytest

from server.runtime import ensure_supported_python


def test_runtime_guard_accepts_supported_version() -> None:
    ensure_supported_python((3, 11, 0))
    ensure_supported_python((3, 12, 1))


def test_runtime_guard_rejects_older_version() -> None:
    with pytest.raises(RuntimeError, match="Python 3.11\\+"):
        ensure_supported_python((3, 10, 13))
