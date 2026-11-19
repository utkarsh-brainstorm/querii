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
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")  # Power-cut & crash safe in WAL mode, highly performant
    conn.execute("PRAGMA cache_size=-64000")   # 64MB RAM page cache
    conn.execute("PRAGMA mmap_size=268435456") # 256MB memory-mapped I/O for instant reads
    conn.execute("PRAGMA temp_store=MEMORY")   # Memory temporary store
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
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sql_text      TEXT NOT NULL,
    ran_at        DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
    row_count     INTEGER DEFAULT 0,
    source        TEXT DEFAULT 'manual',
    builder_state TEXT
);

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    provider      TEXT,
    model         TEXT,
    messages_json TEXT NOT NULL,
    created_at    DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at    DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);
"""


def init_db() -> None:
    """Create internal management tables and run lightweight migrations. Safe to call multiple times."""
    conn = _connect()
    try:
        conn.executescript(_INTERNAL_SCHEMA)
        # Migration: ensure builder_state column exists in existing databases
        try:
            conn.execute("ALTER TABLE query_log ADD COLUMN builder_state TEXT")
        except Exception:
            pass
        # Migration: ensure ai_chat_sessions exists
        try:
            conn.execute("""
            CREATE TABLE IF NOT EXISTS ai_chat_sessions (
                id            TEXT PRIMARY KEY,
                title         TEXT NOT NULL,
                provider      TEXT,
                model         TEXT,
                messages_json TEXT NOT NULL,
                created_at    DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at    DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
            )
            """)
        except Exception:
            pass
        conn.commit()
    finally:
        conn.close()


def checkpoint_db() -> None:
    """Safely flush WAL to the main database file and optimize on shutdown."""
    conn = _connect()
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("PRAGMA optimize")
        conn.commit()
    except Exception as e:
        print(f"[DB] Checkpoint warning: {e}")
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
    filepath: Optional[str],
    header_row_index: int = 0,
    overwrite: bool = False,
    custom_table_name: Optional[str] = None,
    raw_rows: Optional[List[List[str]]] = None,
) -> Tuple[str, int, int]:
    """
    Create (or replace) a table for the given sheet and insert all rows.

    If raw_rows is provided, filepath is not used for data reading.
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

        # Read all rows — either from raw_rows or from file
        if raw_rows is not None:
            all_rows = raw_rows
        elif filepath:
            all_rows = read_all_rows(filepath, header_row_index, ncols=len(preview.columns))
        else:
            all_rows = []

        # Insert
        col_names = ", ".join(f'"{c.sqlite_name}"' for c in preview.columns)
        placeholders = ", ".join("?" * len(preview.columns))
        src = preview.filename or "csv_editor"
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

                conn.execute(insert_sql, [src] + typed_row)
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
        # Store last filepath only if we had a real file
        if filepath:
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
# Generic query executor & multi-statement splitter
# ---------------------------------------------------------------------------

def split_sql_statements(sql: str) -> List[str]:
    """
    Split SQL script into individual statements.
    Respects single quotes, double quotes, backticks, line comments (--), and block comments (/* */).
    """
    statements = []
    current = []
    in_single_quote = False
    in_double_quote = False
    in_backtick = False
    in_line_comment = False
    in_block_comment = False
    i = 0
    n = len(sql)
    while i < n:
        c = sql[i]
        next_c = sql[i + 1] if i + 1 < n else ''

        if in_line_comment:
            current.append(c)
            if c == '\n':
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            current.append(c)
            if c == '*' and next_c == '/':
                current.append('/')
                i += 2
                in_block_comment = False
                continue
            i += 1
            continue

        if in_single_quote:
            current.append(c)
            if c == '\\' and next_c:
                current.append(next_c)
                i += 2
                continue
            elif c == "'" and next_c == "'":
                current.append("'")
                i += 2
                continue
            elif c == "'":
                in_single_quote = False
            i += 1
            continue

        if in_double_quote:
            current.append(c)
            if c == '\\' and next_c:
                current.append(next_c)
                i += 2
                continue
            elif c == '"' and next_c == '"':
                current.append('"')
                i += 2
                continue
            elif c == '"':
                in_double_quote = False
            i += 1
            continue

        if in_backtick:
            current.append(c)
            if c == '`':
                in_backtick = False
            i += 1
            continue

        # Check for comments start
        if c == '-' and next_c == '-':
            in_line_comment = True
            current.append('-')
            current.append('-')
            i += 2
            continue

        if c == '/' and next_c == '*':
            in_block_comment = True
            current.append('/')
            current.append('*')
            i += 2
            continue

        if c == "'":
            in_single_quote = True
            current.append(c)
            i += 1
            continue

        if c == '"':
            in_double_quote = True
            current.append(c)
            i += 1
            continue

        if c == '`':
            in_backtick = True
            current.append(c)
            i += 1
            continue

        if c == ';':
            stmt = ''.join(current).strip()
            if stmt:
                statements.append(stmt)
            current = []
            i += 1
            continue

        current.append(c)
        i += 1

    last_stmt = ''.join(current).strip()
    if last_stmt:
        statements.append(last_stmt)
    return statements


def execute_query_full(sql: str, params: tuple = ()) -> Tuple[List[str], List[Dict], int, Optional[str]]:
    """
    Execute SQL statement or multi-statement script.
    Allows all standard SQL: SELECT, WITH, PRAGMA, INSERT, UPDATE, DELETE, ALTER TABLE, CREATE TABLE, DROP TABLE, DROP VIEW, TRUNCATE.
    Returns (columns, rows, affected_rows, target_table).
    """
    import re

    stmts = split_sql_statements(sql)
    if not stmts:
        return [], [], 0, None

    conn = _connect()
    try:
        cols: List[str] = []
        rows: List[Dict] = []
        total_affected = 0
        target_table: Optional[str] = None
        created_tables: List[str] = []
        dropped_tables: List[str] = []
        inserted_tables: List[str] = []

        def _extract_tbl(pattern: str, text: str) -> Optional[str]:
            m = re.search(pattern, text, re.IGNORECASE)
            return m.group(1).strip('"`\'[]') if m else None

        if len(stmts) == 1:
            clean = re.sub(r"/\*.*?\*/", "", stmts[0], flags=re.DOTALL)
            clean = re.sub(r"--[^\n]*", "", clean).strip()

            cur = conn.execute(stmts[0], params)
            conn.commit()

            if cur.description:
                cols = [d[0] for d in cur.description]
                rows = [dict(r) for r in cur.fetchall()]
            total_affected = cur.rowcount

            # Table tracking
            drop_tbl = _extract_tbl(r"\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_`\"'\[\]]+)", clean)
            if drop_tbl:
                conn.execute("DELETE FROM import_log WHERE table_name = ?", (drop_tbl,))
                conn.commit()
                target_table = drop_tbl

            create_tbl = _extract_tbl(r"\bCREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_`\"'\[\]]+)", clean)
            if create_tbl:
                target_table = create_tbl
                if not cols:
                    try:
                        c_chk = conn.execute(f'SELECT * FROM "{create_tbl}" LIMIT 100')
                        if c_chk.description:
                            cols = [d[0] for d in c_chk.description]
                            rows = [dict(r) for r in c_chk.fetchall()]
                    except Exception:
                        pass

            ins_tbl = _extract_tbl(r"\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-zA-Z0-9_`\"'\[\]]+)", clean)
            if ins_tbl and not target_table:
                target_table = ins_tbl

            return cols, rows, total_affected, target_table

        # Multi-statement transactional execution
        changes_before = conn.total_changes
        with conn:
            for stmt in stmts:
                clean = re.sub(r"/\*.*?\*/", "", stmt, flags=re.DOTALL)
                clean = re.sub(r"--[^\n]*", "", clean).strip()
                if not clean:
                    continue

                cur = conn.execute(stmt)

                if cur.description:
                    cols = [d[0] for d in cur.description]
                    rows = [dict(r) for r in cur.fetchall()]

                c_tbl = _extract_tbl(r"\bCREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_`\"'\[\]]+)", clean)
                if c_tbl:
                    created_tables.append(c_tbl)
                    target_table = c_tbl

                d_tbl = _extract_tbl(r"\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_`\"'\[\]]+)", clean)
                if d_tbl:
                    dropped_tables.append(d_tbl)

                i_tbl = _extract_tbl(r"\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-zA-Z0-9_`\"'\[\]]+)", clean)
                if i_tbl:
                    inserted_tables.append(i_tbl)
                    if not target_table:
                        target_table = i_tbl

        total_affected = conn.total_changes - changes_before

        for d_tbl in dropped_tables:
            try:
                conn.execute("DELETE FROM import_log WHERE table_name = ?", (d_tbl,))
                conn.commit()
            except Exception:
                pass

        # If DDL/DML script returned no direct rows, query created or modified table
        if not cols and (created_tables or inserted_tables):
            cand_tbl = created_tables[-1] if created_tables else inserted_tables[-1]
            try:
                c_load = conn.execute(f'SELECT * FROM "{cand_tbl}" LIMIT 200')
                if c_load.description:
                    cols = [d[0] for d in c_load.description]
                    rows = [dict(r) for r in c_load.fetchall()]
                    target_table = cand_tbl
            except Exception:
                pass

        return cols, rows, total_affected, target_table
    finally:
        conn.close()


def execute_query(sql: str, params: tuple = ()) -> Tuple[List[str], List[Dict]]:
    """Execute SQL query/mutation and return (columns, rows)."""
    cols, rows, _, _ = execute_query_full(sql, params)
    return cols, rows


# ---------------------------------------------------------------------------
# Query log
# ---------------------------------------------------------------------------

def log_query(sql: str, row_count: int = 0, source: str = "manual", builder_state: Optional[str] = None) -> None:
    sql_stripped = sql.strip()
    if not sql_stripped or len(sql_stripped) < 4:
        return
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO query_log (sql_text, row_count, source, builder_state) VALUES (?, ?, ?, ?)",
            (sql_stripped, row_count, source, builder_state),
        )
        conn.execute(
            "DELETE FROM query_log WHERE id NOT IN "
            "(SELECT id FROM query_log ORDER BY id DESC LIMIT 500)"
        )
        conn.commit()
    finally:
        conn.close()


def get_query_log() -> List[Dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, sql_text, ran_at, row_count, source, builder_state "
            "FROM query_log ORDER BY id DESC LIMIT 500"
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


# ---------------------------------------------------------------------------
# AI Chat Sessions & Tab Persistence
# ---------------------------------------------------------------------------

def save_ai_session(session_id: str, title: str, provider: str, model: str, messages_json: str) -> None:
    """Save or update an AI conversation session in SQLite."""
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO ai_chat_sessions (id, title, provider, model, messages_json, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                provider = excluded.provider,
                model = excluded.model,
                messages_json = excluded.messages_json,
                updated_at = excluded.updated_at
            """,
            (session_id, title, provider, model, messages_json),
        )
        conn.commit()
    finally:
        conn.close()


def get_ai_sessions(limit: int = 50) -> List[Dict]:
    """Retrieve saved AI conversation sessions ordered by most recently updated."""
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT id, title, provider, model, messages_json, created_at, updated_at
            FROM ai_chat_sessions
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_ai_session(session_id: str) -> bool:
    """Delete an AI conversation session."""
    conn = _connect()
    try:
        cursor = conn.execute("DELETE FROM ai_chat_sessions WHERE id = ?", (session_id,))
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


def save_persisted_tabs(tabs_json: str) -> None:
    """Persist active tabs layout and states to app_settings."""
    set_setting("persisted_tabs_session", tabs_json)


def get_persisted_tabs() -> Optional[str]:
    """Retrieve persisted tabs layout and states from app_settings."""
    val = get_setting("persisted_tabs_session")
    return val if val else None

