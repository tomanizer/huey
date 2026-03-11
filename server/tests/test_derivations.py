"""Tests for backend derivation registry and helpers."""

import pytest

from server.derivations import apply_derivation, get_output_name
from server.errors import DerivationNotSupportedError


def test_get_output_name_defaults_to_field() -> None:
    assert get_output_name("symbol", None, None) == "symbol"


def test_get_output_name_uses_derivation_suffix() -> None:
    assert get_output_name("date", "year", None) == "date__year"


def test_get_output_name_prefers_alias() -> None:
    assert get_output_name("date", "year", "trade_year") == "trade_year"


@pytest.mark.parametrize(
    ("derivation", "field_type", "fragment"),
    [
        ("year", "date", "YEAR"),
        ("month_name", "timestamp", "MONTH"),
        ("uppercase", "string", "UPPER"),
        ("first_letter", "string", "upper"),
        ("hash", "string", "hash"),
        ("sha256", "string", "sha256"),
    ],
)
def test_apply_derivation_supported(derivation: str, field_type: str, fragment: str) -> None:
    expression = apply_derivation(derivation, '"value"', "value", field_type, ["body", "field"])
    assert fragment in expression


def test_apply_derivation_unknown_raises() -> None:
    with pytest.raises(DerivationNotSupportedError):
        apply_derivation("not_real", '"value"', "value", "string", ["body", "field"])


def test_apply_derivation_type_mismatch_raises() -> None:
    with pytest.raises(DerivationNotSupportedError):
        apply_derivation("year", '"symbol"', "symbol", "string", ["body", "field"])
