"""
core/db.py
==========
SQLite database layer for Querii.

Dynamic design: each imported file becomes its own table.

Internal tables (not user-data):
  - import_log   : tracks which files have been imported
  - app_settings : key/value settings
  - query_log    : last 100 executed queries
"""

from __future__ import annotations

import glob
import os
import shutil
import sqlite3
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from core.schema import (
    ColumnInfo, describe_schema, get_all_tables,
    get_table_columns, sanitise_table_name,
)
from core.importer import ImportPreview, read_all_rows


# ---------------------------------------------------------------------------
# DB path
# ---------------------------------------------------------------------------

_DB_PATH: Optional[str] = None


def set_db_path(path: str) -> None:
    global _DB_PATH
    _DB_PATH = path


def get_db_path() -> str:
    if _DB_PATH:
        return _DB_PATH
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "data", "querii.db")


def _connect() -> sqlite3.Connection:
    db_path = get_db_path()
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ---------------------------------------------------------------------------
# Internal schema (management tables only)
# ---------------------------------------------------------------------------

_INTERNAL_SCHEMA = """
CREATE TABLE IF NOT EXISTS import_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    filename        TEXT NOT NULL,
    table_name      TEXT NOT NULL,
    imported_at     DATETIME NOT NULL,
    rows_imported   INTEGER,
    col_count       INTEGER,
    header_row      INTEGER DEFAULT 0,
    overwritten     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS query_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sql_text   TEXT NOT NULL,
    ran_at     DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
    row_count  INTEGER DEFAULT 0,
    source     TEXT DEFAULT 'manual'
);
"""


def init_db() -> None:
    """Create internal management tables. Safe to call multiple times."""
    conn = _connect()
    try:
        conn.executescript(_INTERNAL_SCHEMA)
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def get_setting(key: str, default: str = "") -> str:
    conn = _connect()
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def set_setting(key: str, value: str) -> None:
    conn = _connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (key, value)
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def get_existing_table_names() -> set:
    conn = _connect()
    try:
        return set(get_all_tables(conn))
    finally:
        conn.close()


def import_sheet(
    preview: ImportPreview,
    filepath: str,
    header_row_index: int = 0,
    overwrite: bool = False,
    custom_table_name: Optional[str] = None,
) -> Tuple[str, int, int]:
    """
    Create (or replace) a table for the given sheet and insert all rows.

    Returns (table_name, rows_inserted, rows_skipped).
    """
    # --- Backup ---
    db_path = get_db_path()
    if os.path.exists(db_path):
        backup_dir = os.path.join(os.path.dirname(db_path), "backups")
        os.makedirs(backup_dir, exist_ok=True)
        backup_name = f"querii_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
        try:
            shutil.copy2(db_path, os.path.join(backup_dir, backup_name))
            backups = sorted(glob.glob(os.path.join(backup_dir, "querii_backup_*.db")))
            while len(backups) > 12:
                os.remove(backups.pop(0))
        except Exception:
            pass

    conn = _connect()
    try:
        existing = set(get_all_tables(conn))

        # Determine table name
        if custom_table_name:
            tname = sanitise_table_name(custom_table_name, existing=None)
        else:
            tname = sanitise_table_name(preview.filename, existing=existing.copy())

        if overwrite and tname in existing:
            conn.execute(f'DROP TABLE IF EXISTS "{tname}"')
            conn.commit()

        # Build CREATE TABLE
        col_defs = ['_row_id INTEGER PRIMARY KEY AUTOINCREMENT', '_source TEXT']
        for col in preview.columns:
            col_defs.append(f'"{col.sqlite_name}" {col.sql_type}')
        create_sql = f'CREATE TABLE IF NOT EXISTS "{tname}" ({", ".join(col_defs)})'
        conn.execute(create_sql)
        conn.commit()

        # Read all rows
        all_rows = read_all_rows(filepath, header_row_index, ncols=len(preview.columns))

        # Insert
        col_names = ", ".join(f'"{c.sqlite_name}"' for c in preview.columns)
        placeholders = ", ".join("?" * len(preview.columns))
        insert_sql = f'INSERT INTO "{tname}" (_source, {col_names}) VALUES (?, {placeholders})'

        inserted = 0
        skipped = 0
        for row in all_rows:
            try:
                # Cast values according to inferred type
                typed_row = []
                for i, col in enumerate(preview.columns):
                    val = row[i].strip() if i < len(row) else ""
                    if not val:
                        typed_row.append(None)
                        continue
                    if col.sql_type == "INTEGER":
                        try:
                            typed_row.append(int(float(val)))
                        except ValueError:
                            typed_row.append(val)
                    elif col.sql_type == "REAL":
                        try:
                            typed_row.append(float(val))
                        except ValueError:
                            typed_row.append(val)
                    else:
                        typed_row.append(val)

                conn.execute(insert_sql, [preview.filename] + typed_row)
                inserted += 1
            except Exception:
                skipped += 1

        # Log the import
        conn.execute(
            """INSERT INTO import_log
               (filename, table_name, imported_at, rows_imported, col_count, header_row, overwritten)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                preview.filename, tname, datetime.now().isoformat(),
                inserted, len(preview.columns), header_row_index,
                1 if overwrite else 0,
            ),
        )
        # Store last filepath
        conn.execute(
            "INSERT OR REPLACE INTO app_settings(key,value) VALUES ('last_import_filepath',?)",
            (filepath,)
        )
        conn.commit()
        return tname, inserted, skipped
    finally:
        conn.close()


def drop_table(table_name: str) -> None:
    """Drop a user-data table."""
    conn = _connect()
    try:
        conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')
        conn.execute("DELETE FROM import_log WHERE table_name=?", (table_name,))
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Import log
# ---------------------------------------------------------------------------

def get_import_history() -> List[Dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM import_log ORDER BY imported_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def check_already_imported(filename: str) -> Optional[Dict]:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM import_log WHERE filename=? ORDER BY imported_at DESC LIMIT 1",
            (filename,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_last_import() -> Optional[Dict]:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM import_log ORDER BY imported_at DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        result = dict(row)
        fp = conn.execute(
            "SELECT value FROM app_settings WHERE key='last_import_filepath'"
        ).fetchone()
        result["filepath_hint"] = fp["value"] if fp else ""
        return result
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def get_schema() -> List[Dict]:
    """Return full schema description for all user tables."""
    conn = _connect()
    try:
        return describe_schema(conn)
    finally:
        conn.close()


def get_table_column_meta(table_name: str) -> List[Dict]:
    """Return column metadata for a specific table."""
    conn = _connect()
    try:
        return get_table_columns(conn, table_name)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Generic query executor
# ---------------------------------------------------------------------------

def execute_query(sql: str, params: tuple = ()) -> Tuple[List[str], List[Dict]]:
    """
    Execute any SELECT / WITH / PRAGMA query.
    Returns (column_names, rows).
    Non-SELECT statements are blocked.
    """
    stripped = sql.strip().upper()
    if not (
        stripped.startswith("SELECT")
        or stripped.startswith("WITH")
        or stripped.startswith("PRAGMA")
    ):
        raise ValueError(
            "Only SELECT queries are permitted.\n"
            "To modify data, use Import."
        )

    conn = _connect()
    try:
        cur = conn.execute(sql, params)
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = [dict(r) for r in cur.fetchall()]
        return cols, rows
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Query log
# ---------------------------------------------------------------------------

def log_query(sql: str, row_count: int = 0, source: str = "manual") -> None:
    sql_stripped = sql.strip()
    if not sql_stripped or len(sql_stripped) < 8:
        return
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO query_log (sql_text, row_count, source) VALUES (?, ?, ?)",
            (sql_stripped, row_count, source),
        )
        conn.execute(
            "DELETE FROM query_log WHERE id NOT IN "
            "(SELECT id FROM query_log ORDER BY id DESC LIMIT 100)"
        )
        conn.commit()
    finally:
        conn.close()


def get_query_log() -> List[Dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, sql_text, ran_at, row_count, source "
            "FROM query_log ORDER BY id DESC LIMIT 100"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def clear_query_log() -> None:
    conn = _connect()
    try:
        conn.execute("DELETE FROM query_log")
        conn.commit()
    finally:
        conn.close()
