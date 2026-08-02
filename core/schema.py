"""
core/schema.py
==============
Column type inference and schema introspection for Querii.

Given a list of string cell values, infers the most appropriate SQLite
storage type (INTEGER | REAL | DATE | TIME | TEXT) and provides helpers
to describe the live database schema to the frontend.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Type inference
# ---------------------------------------------------------------------------

_DATE_PATTERNS = [
    re.compile(r"^\d{4}-\d{2}-\d{2}$"),                         # 2024-07-15
    re.compile(r"^\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4}$"),      # 15/07/2024 or 15-07-24
    re.compile(r"^\d{1,2}[-\s][A-Za-z]{3,9}[-\s]\d{2,4}$"),    # 15-Jul-2024
]
_TIME_PATTERN  = re.compile(r"^\d{1,2}:\d{2}(:\d{2})?$")


def _looks_like_date(v: str) -> bool:
    return any(p.match(v.strip()) for p in _DATE_PATTERNS)


def _looks_like_time(v: str) -> bool:
    return bool(_TIME_PATTERN.match(v.strip()))


def infer_type(samples: List[str]) -> str:
    """
    Given a list of non-empty string samples from a column, return the
    best SQLite type: INTEGER | REAL | DATE | TIME | TEXT.
    """
    non_empty = [s.strip() for s in samples if s.strip()]
    if not non_empty:
        return "TEXT"

    # Try integer
    try:
        [int(v) for v in non_empty]
        return "INTEGER"
    except ValueError:
        pass

    # Try real
    try:
        [float(v) for v in non_empty]
        return "REAL"
    except ValueError:
        pass

    # Try date
    if all(_looks_like_date(v) for v in non_empty):
        return "DATE"

    # Try time
    if all(_looks_like_time(v) for v in non_empty):
        return "TIME"

    return "TEXT"


# ---------------------------------------------------------------------------
# Column descriptor
# ---------------------------------------------------------------------------

class ColumnInfo:
    """Metadata about one column in an imported sheet."""

    def __init__(self, raw_name: str, sqlite_name: str, sql_type: str, samples: List[str]):
        self.raw_name   = raw_name      # as read from header row
        self.sqlite_name = sqlite_name  # sanitised for use as SQL identifier
        self.sql_type   = sql_type      # INTEGER | REAL | DATE | TIME | TEXT
        self.samples    = samples[:5]   # up to 5 sample values

    def to_dict(self) -> dict:
        return {
            "raw_name":    self.raw_name,
            "sqlite_name": self.sqlite_name,
            "sql_type":    self.sql_type,
            "samples":     self.samples,
        }


# ---------------------------------------------------------------------------
# Name sanitiser
# ---------------------------------------------------------------------------

def sanitise_identifier(name: str, existing: Optional[set] = None) -> str:
    """
    Convert an arbitrary header string to a safe SQLite column/table name.
    - Strips leading/trailing whitespace
    - Replaces runs of non-alphanumeric chars with _
    - Prepends col_ if starts with a digit
    - Ensures uniqueness within `existing` set by appending _2, _3, …
    """
    s = name.strip()
    s = re.sub(r"[^A-Za-z0-9_]", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        s = "col"
    if s[0].isdigit():
        s = "col_" + s
    s = s.lower()

    if existing is not None:
        base = s
        counter = 2
        while s in existing:
            s = f"{base}_{counter}"
            counter += 1
        existing.add(s)

    return s


def sanitise_table_name(filename: str, existing: Optional[set] = None) -> str:
    """
    Derive a safe table name from a filename.
    e.g. "My Employees 2024.xlsx" → "my_employees_2024"
    """
    import os
    stem = os.path.splitext(os.path.basename(filename))[0]
    name = sanitise_identifier(stem)
    if not name:
        name = "sheet"

    if existing is not None:
        base = name
        counter = 2
        while name in existing:
            name = f"{base}_{counter}"
            counter += 1
        existing.add(name)

    return name


# ---------------------------------------------------------------------------
# Live schema introspection from a connected DB
# ---------------------------------------------------------------------------

def get_all_tables(conn: sqlite3.Connection) -> List[str]:
    """Return all user-created table names (excludes sqlite_* internals)."""
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
        "ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows]


def get_table_columns(conn: sqlite3.Connection, table: str) -> List[Dict]:
    """Return column info for a table as list of {name, type}."""
    rows = conn.execute(f"PRAGMA table_info(\"{table}\")").fetchall()
    return [{"name": r["name"], "type": r["type"]} for r in rows]


def get_table_sample(conn: sqlite3.Connection, table: str, limit: int = 3) -> List[Dict]:
    """Return a few sample rows from a table."""
    try:
        rows = conn.execute(f"SELECT * FROM \"{table}\" LIMIT {limit}").fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def describe_schema(conn: sqlite3.Connection) -> List[Dict]:
    """
    Return a full schema description:
    [{ table, columns: [{name, type}], sample_rows: [{...}] }]
    """
    result = []
    for table in get_all_tables(conn):
        # Skip internal Querii tables
        if table in ("import_log", "app_settings", "query_log"):
            continue
        cols = get_table_columns(conn, table)
        samples = get_table_sample(conn, table)
        result.append({
            "table":       table,
            "columns":     cols,
            "sample_rows": samples,
        })
    return result
