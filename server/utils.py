"""Shared utilities for the QueryService backend."""


def quote_identifier(identifier: str) -> str:
    """Double-quote a SQL identifier, escaping any embedded quotes."""
    return '"' + identifier.replace('"', '""') + '"'
