"""Backend derivation registry for v1 query endpoints."""

from typing import Any

from server.errors import DerivationNotSupportedError
from server.utils import quote_identifier as _quote

_STRING_TYPES = {"VARCHAR", "TEXT", "STRING", "JSON"}
_DATE_TYPES = {"DATE"}

_DERIVATIONS: dict[str, dict[str, Any]] = {
    "year": {"template": "CAST(YEAR({expr}) AS INT)", "kinds": {"date", "timestamp"}},
    "iso_year": {"template": "CAST(ISOYEAR({expr}) AS INT)", "kinds": {"date", "timestamp"}},
    "quarter": {"template": "'Q' || QUARTER({expr})", "kinds": {"date", "timestamp"}},
    "month_num": {"template": "CAST(MONTH({expr}) AS UTINYINT)", "kinds": {"date", "timestamp"}},
    "month_name": {"template": "CAST(MONTH({expr}) AS UTINYINT)", "kinds": {"date", "timestamp"}},
    "month_shortname": {"template": "CAST(MONTH({expr}) AS UTINYINT)", "kinds": {"date", "timestamp"}},
    "week_num": {"template": "CAST(WEEK({expr}) AS UTINYINT)", "kinds": {"date", "timestamp"}},
    "day_of_year": {"template": "CAST(DAYOFYEAR({expr}) AS USMALLINT)", "kinds": {"date", "timestamp"}},
    "day_of_month": {"template": "CAST(DAYOFMONTH({expr}) AS UTINYINT)", "kinds": {"date", "timestamp"}},
    "day_of_week_num": {"template": "CAST(DAYOFWEEK({expr}) AS UTINYINT)", "kinds": {"date", "timestamp"}},
    "iso_day_of_week": {"template": "CAST(ISODOW({expr}) AS UTINYINT)", "kinds": {"date", "timestamp"}},
    "day_of_week_name": {"template": "CAST(DAYOFWEEK({expr}) AS UTINYINT)", "kinds": {"date", "timestamp"}},
    "day_of_week_shortname": {"template": "CAST(DAYOFWEEK({expr}) AS UTINYINT)", "kinds": {"date", "timestamp"}},
    "local_date": {"template": "{expr}::DATE", "kinds": {"date", "timestamp"}},
    "iso_date": {"template": "strftime({expr}, '%x')", "kinds": {"date", "timestamp"}},
    "hour": {"template": "CAST(HOUR({expr}) AS UTINYINT)", "kinds": {"timestamp"}},
    "minute": {"template": "CAST(MINUTE({expr}) AS UTINYINT)", "kinds": {"timestamp"}},
    "second": {"template": "CAST(SECOND({expr}) AS UTINYINT)", "kinds": {"timestamp"}},
    "iso_time": {"template": "strftime({expr}, '%H:%M:%S')", "kinds": {"timestamp"}},
    "epoch_secs": {"template": "epoch({expr})", "kinds": {"timestamp"}},
    "epoch_millis": {"template": "epoch_ms({expr})", "kinds": {"timestamp"}},
    "epoch_micros": {"template": "epoch_us({expr})", "kinds": {"timestamp"}},
    "epoch_nanos": {"template": "epoch_ns({expr})", "kinds": {"timestamp"}},
    "uppercase": {"template": "UPPER({expr})", "kinds": {"string"}},
    "lowercase": {"template": "LOWER({expr})", "kinds": {"string"}},
    "first_letter": {"template": "upper({expr}[1])", "kinds": {"string"}},
    "length": {"template": "length({expr})", "kinds": {"string"}},
    "noaccent": {"template": "{expr} COLLATE NOACCENT", "kinds": {"string"}},
    "nocase": {"template": "{expr} COLLATE NOCASE", "kinds": {"string"}},
    "hash": {"template": "hash({expr})", "kinds": {"any"}},
    "md5_hex": {"template": "md5({expr})", "kinds": {"string"}},
    "sha256": {"template": "sha256({expr})", "kinds": {"string"}},
}


def _type_kind(type_name: str | None) -> set[str]:
    normalized = str(type_name or "").upper()
    kinds = {"any"}
    if normalized in _DATE_TYPES:
        kinds.add("date")
    if normalized.startswith("TIMESTAMP"):
        kinds.add("timestamp")
    if normalized in _STRING_TYPES:
        kinds.add("string")
    return kinds


def get_output_name(field: str, derivation: str | None, alias: str | None) -> str:
    if alias:
        return alias
    if derivation:
        return f"{field}__{derivation}"
    return field


def apply_derivation(
    derivation: str,
    column_expression: str,
    field_name: str,
    field_type: str | None,
    loc: list[Any],
) -> str:
    info = _DERIVATIONS.get(derivation)
    if info is None:
        raise DerivationNotSupportedError(
            [
                {
                    "loc": loc,
                    "msg": f"Unknown derivation: {derivation}",
                    "type": "derivation_not_supported",
                    "ctx": {"derivation": derivation, "field": field_name},
                }
            ]
        )
    if not (_type_kind(field_type) & set(info["kinds"])):
        raise DerivationNotSupportedError(
            [
                {
                    "loc": loc,
                    "msg": f"Derivation {derivation} is not supported for field type {field_type or 'unknown'}",
                    "type": "derivation_not_supported",
                    "ctx": {"derivation": derivation, "field": field_name, "field_type": field_type},
                }
            ]
        )
    return str(info["template"]).format(expr=column_expression)


def quote_output_name(field: str, derivation: str | None, alias: str | None) -> str:
    return _quote(get_output_name(field, derivation, alias))
