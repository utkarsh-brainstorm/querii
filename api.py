"""
api.py
======
Python API exposed to the webview frontend via window.pywebview.api.
Every public method returns { ok: bool, data: any, error: str | None }
"""

from __future__ import annotations

import json
import os
import threading
import traceback
from typing import Any, Dict, List, Optional

import webview

import core.db as db
from core import exporter
from core.importer import preview_file, ImportPreview
from core.query_builder import (
    FilterRow, FilterGroup, QuerySpec,
    build_sql, build_where_tree,
    get_operators_for_category, sql_type_to_category,
    format_sql_readable,
)


def _ok(data: Any = None) -> dict:
    return {"ok": True, "data": data, "error": None}


def _err(msg: Any) -> dict:
    return {"ok": False, "data": None, "error": str(msg)}


def _parse_filter_groups(groups_raw: list) -> List[FilterGroup]:
    """
    Recursively parse the JS FilterGroup tree into Python FilterGroup objects.
    Each item in a group can be a condition (FilterRow) or a nested group.
    """
    result = []
    for g in groups_raw:
        grp = FilterGroup(joiner=g.get("joiner", "AND"), items=[])
        for item in g.get("items", []):
            if item.get("_type") == "group":
                # Nested group — recurse
                sub_groups = _parse_filter_groups([item])
                if sub_groups:
                    nested = sub_groups[0]
                    nested.joiner = item.get("joiner", "AND")
                    grp.items.append(nested)
            else:
                # Leaf condition
                grp.items.append(FilterRow(
                    field    = item.get("field", ""),
                    operator = item.get("operator", "equals"),
                    value    = item.get("value", ""),
                    value2   = item.get("value2", ""),
                    joiner   = item.get("joiner", "AND"),
                    category = item.get("category", "text"),
                    table_prefix = item.get("table_prefix", ""),
                ))
        if grp.items:
            result.append(grp)
    return result


class Api:
    def __init__(self):
        self._window: Optional[webview.Window] = None
        self._import_lock = threading.Lock()
        self._pending_preview: Optional[ImportPreview] = None
        self._pending_filepath: Optional[str] = None
        self._last_result_cols: List[str] = []
        self._last_result_rows: List[dict] = []

    def set_window(self, window: webview.Window):
        self._window = window

    # ----------------------------------------------------------------
    # Settings
    # ----------------------------------------------------------------

    def get_settings(self) -> dict:
        try:
            keys = [
                "org_name", "org_logo_b64",
                "ap_theme", "ap_zoom", "ap_custom_reports", "ap_pdf_dir",
            ]
            return _ok({k: db.get_setting(k) for k in keys})
        except Exception as e:
            return _err(e)

    def save_settings(self, settings: dict) -> dict:
        try:
            for k, v in settings.items():
                db.set_setting(str(k), str(v) if v is not None else "")
            return _ok("Saved.")
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # File dialogs
    # ----------------------------------------------------------------

    def open_file_dialog(self) -> dict:
        try:
            if self._window is None:
                return _err("Window not ready.")
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=(
                    "Supported Files (*.xls;*.xlsx;*.xlsm;*.csv)",
                    "Excel Files (*.xls;*.xlsx;*.xlsm)",
                    "CSV Files (*.csv)",
                    "All files (*.*)",
                ),
            )
            if result:
                return _ok(result[0])
            return _ok(None)
        except Exception as e:
            return _err(e)

    def open_file_dialog_type(self, file_type: str = "image") -> dict:
        try:
            if self._window is None:
                return _err("Window not ready.")
            if file_type == "image":
                types = ("PNG Images (*.png)", "All files (*.*)")
            else:
                types = ("All files (*.*)",)
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG, allow_multiple=False, file_types=types
            )
            if result:
                return _ok(result[0])
            return _ok(None)
        except Exception as e:
            return _err(e)

    def save_file_dialog(self, default_name: str = "export", ext: str = "csv") -> dict:
        try:
            if self._window is None:
                return _err("Window not ready.")
            if ext == "pdf":
                types = ("PDF Files (*.pdf)",)
                default = default_name + ".pdf"
            else:
                types = ("CSV Files (*.csv)",)
                default = default_name + ".csv"
            result = self._window.create_file_dialog(
                webview.SAVE_DIALOG, save_filename=default, file_types=types
            )
            if result:
                path = result if isinstance(result, str) else result[0]
                return _ok(path)
            return _ok(None)
        except Exception as e:
            return _err(e)

    def get_default_downloads_dir(self) -> dict:
        """Return the platform-default Downloads folder."""
        try:
            home = os.path.expanduser("~")
            # Try XDG user dirs on Linux first
            downloads = os.path.join(home, "Downloads")
            xdg_dirs = os.path.join(home, ".config", "user-dirs.dirs")
            if os.path.isfile(xdg_dirs):
                with open(xdg_dirs) as f:
                    for line in f:
                        if line.startswith("XDG_DOWNLOAD_DIR"):
                            val = line.split("=", 1)[1].strip().strip('"').replace("$HOME", home)
                            if os.path.isdir(val):
                                downloads = val
            if not os.path.isdir(downloads):
                downloads = home
            return _ok(downloads)
        except Exception as e:
            return _err(e)

    def choose_folder_dialog(self) -> dict:
        """Open a native folder picker and return selected path."""
        try:
            if self._window is None:
                return _err("Window not ready.")
            result = self._window.create_file_dialog(
                webview.FOLDER_DIALOG,
            )
            if result:
                path = result if isinstance(result, str) else result[0]
                return _ok(path)
            return _ok(None)
        except Exception as e:
            return _err(e)

    def read_file_as_b64(self, filepath: str) -> dict:
        try:
            import base64
            if not os.path.isfile(filepath):
                return _err(f"File not found: {filepath}")
            size = os.path.getsize(filepath)
            if size > 5 * 1024 * 1024:
                return _err("File too large (max 5 MB for logo).")
            with open(filepath, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            return _ok(data)
        except Exception as e:
            return _err(e)

    def check_filepath_exists(self, filepath: str) -> dict:
        try:
            return _ok(os.path.isfile(filepath))
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Import — two-phase: preview then confirm
    # ----------------------------------------------------------------

    def preview_import(self, filepath: str, header_row_index: int = 0) -> dict:
        try:
            if not os.path.isfile(filepath):
                return _err(f"File not found: {filepath}")

            prev = preview_file(filepath, header_row_index=header_row_index)
            self._pending_preview = prev
            self._pending_filepath = filepath

            return _ok({
                "filename":   prev.filename,
                "row_count":  prev.row_count,
                "warnings":   prev.warnings,
                "columns": [c.to_dict() for c in prev.columns],
                "sample_rows": prev.sample_rows,
            })
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"Preview failed: {traceback.format_exc()}")

    def confirm_import(
        self,
        overwrite: bool = False,
        custom_table_name: str = "",
        header_row_index: int = 0,
    ) -> dict:
        try:
            if self._pending_preview is None or self._pending_filepath is None:
                return _err("No pending import. Call preview_import first.")

            prev  = self._pending_preview
            fpath = self._pending_filepath

            tname, inserted, skipped = db.import_sheet(
                preview=prev,
                filepath=fpath,
                header_row_index=header_row_index,
                overwrite=overwrite,
                custom_table_name=custom_table_name or None,
            )

            self._pending_preview  = None
            self._pending_filepath = None

            return _ok({
                "table_name": tname,
                "filename":   prev.filename,
                "inserted":   inserted,
                "skipped":    skipped,
                "col_count":  len(prev.columns),
            })
        except Exception as e:
            return _err(f"Import failed: {traceback.format_exc()}")

    def check_already_imported(self, filename: str) -> dict:
        try:
            row = db.check_already_imported(filename)
            return _ok(row)
        except Exception as e:
            return _err(e)

    def get_import_history(self) -> dict:
        try:
            return _ok(db.get_import_history())
        except Exception as e:
            return _err(e)

    def get_last_import(self) -> dict:
        try:
            return _ok(db.get_last_import())
        except Exception as e:
            return _err(e)

    def drop_table(self, table_name: str) -> dict:
        try:
            db.drop_table(table_name)
            return _ok(f"Table '{table_name}' dropped.")
        except Exception as e:
            return _err(e)

    def get_app_data_path(self) -> dict:
        try:
            return _ok(os.path.dirname(db.get_db_path()))
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Schema
    # ----------------------------------------------------------------

    def get_schema(self) -> dict:
        """Return full schema: [{table, columns}]"""
        try:
            return _ok(db.get_schema())
        except Exception as e:
            return _err(e)

    def get_table_columns(self, table_name: str) -> dict:
        """Return column metadata for a specific table."""
        try:
            cols = db.get_table_column_meta(table_name)
            result = []
            for c in cols:
                if c["name"].startswith("_"):
                    continue
                cat = sql_type_to_category(c["type"])
                result.append({
                    "name":      c["name"],
                    "type":      c["type"],
                    "category":  cat,
                    "operators": get_operators_for_category(cat),
                })
            return _ok(result)
        except Exception as e:
            return _err(e)

    def get_column_stats(self, table_name: str, col_name: str) -> dict:
        """
        Return quick stats for a single column:
        count_total, count_distinct, count_null, min_val, max_val, sample_values
        """
        try:
            safe_t = table_name.replace('"', '""')
            safe_c = col_name.replace('"', '""')
            sql = f'''
                SELECT
                    COUNT(*)                         AS count_total,
                    COUNT(DISTINCT "{safe_c}")        AS count_distinct,
                    SUM(CASE WHEN "{safe_c}" IS NULL OR "{safe_c}" = '' THEN 1 ELSE 0 END) AS count_null,
                    MIN("{safe_c}")                   AS min_val,
                    MAX("{safe_c}")                   AS max_val
                FROM "{safe_t}"
            '''
            _, rows = db.execute_query(sql)
            stats = rows[0] if rows else {}

            # Sample top 5 distinct non-null values
            sample_sql = f'''
                SELECT DISTINCT "{safe_c}" AS v
                FROM "{safe_t}"
                WHERE "{safe_c}" IS NOT NULL AND "{safe_c}" != ''
                LIMIT 5
            '''
            _, srows = db.execute_query(sample_sql)
            samples = [r.get("v", "") for r in srows]

            return _ok({
                "count_total":    stats.get("count_total", 0),
                "count_distinct": stats.get("count_distinct", 0),
                "count_null":     stats.get("count_null", 0),
                "min_val":        stats.get("min_val"),
                "max_val":        stats.get("max_val"),
                "sample_values":  samples,
            })
        except Exception as e:
            return _err(str(e))

    # ----------------------------------------------------------------
    # Query
    # ----------------------------------------------------------------

    def run_filter(
        self,
        table: str,
        filter_groups_json: str = "[]",
        sort_col: str = "",
        sort_dir: str = "ASC",
        limit: int = 5000,
        select_exprs_json: str = "[]",
        select_labels_json: str = "[]",
        group_by_exprs_json: str = "[]",
        having: str = "",
        join_tables_json: str = "[]",
        join_clauses_json: str = "[]",
    ) -> dict:
        try:
            groups_raw = json.loads(filter_groups_json) if isinstance(filter_groups_json, str) else filter_groups_json
            sel_e      = json.loads(select_exprs_json)  if isinstance(select_exprs_json, str)  else select_exprs_json
            sel_l      = json.loads(select_labels_json) if isinstance(select_labels_json, str) else select_labels_json
            grp_e      = json.loads(group_by_exprs_json) if isinstance(group_by_exprs_json, str) else group_by_exprs_json
            join_t     = json.loads(join_tables_json)   if isinstance(join_tables_json, str)   else join_tables_json
            join_c     = json.loads(join_clauses_json)  if isinstance(join_clauses_json, str)  else join_clauses_json

            filter_groups = _parse_filter_groups(groups_raw)

            spec = QuerySpec(
                table          = table,
                filter_groups  = filter_groups,
                order_by       = sort_col,
                order_dir      = sort_dir,
                limit          = limit,
                select_exprs   = sel_e,
                select_labels  = sel_l,
                group_by_exprs = grp_e,
                having         = having,
                join_tables    = join_t,
                join_clauses   = join_c,
            )
            sql, params, sql_display = build_sql(spec)
            cols, data = db.execute_query(sql, params)

            self._last_result_cols = cols
            self._last_result_rows = data

            # Log the READABLE (display) SQL, not the parameterised one
            db.log_query(sql_display, len(data), source="filter")

            return _ok({
                "columns": cols,
                "rows":    data[:200], # Send only first page to prevent IPC lag!
                "sql":     sql_display,
                "count":   len(data),
            })
        except Exception as e:
            return _err(str(e))

    def run_sql(self, sql: str) -> dict:
        try:
            cols, data = db.execute_query(sql)
            self._last_result_cols = cols
            self._last_result_rows = data
            # Explicitly log (execute_query logs parameterised; this logs literal)
            db.log_query(sql.strip(), len(data), source="manual")
            return _ok({"columns": cols, "rows": data[:200], "count": len(data)})
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(str(e))

    def get_result_page(self, page_index: int, page_size: int = 200) -> dict:
        try:
            start = page_index * page_size
            end = start + page_size
            return _ok(self._last_result_rows[start:end])
        except Exception as e:
            return _err(str(e))

    # ----------------------------------------------------------------
    # Query log
    # ----------------------------------------------------------------

    def get_query_log(self) -> dict:
        try:
            return _ok(db.get_query_log())
        except Exception as e:
            return _err(e)

    def clear_query_log(self) -> dict:
        try:
            db.clear_query_log()
            return _ok("Cleared.")
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Export
    # ----------------------------------------------------------------

    def export_csv(self, columns: list, rows: list, filepath: str) -> dict:
        try:
            # Ignore frontend rows, use backend memory to prevent huge IPC overhead
            exporter.export_csv(self._last_result_cols, self._last_result_rows, filepath)
            return _ok(filepath)
        except Exception as e:
            return _err(e)

    def export_pdf(
        self,
        columns: list,
        rows: list,
        filepath: str,
        title: str = "Query Results",
        org_name: str = "",
        logo_b64: str = "",
        sql_display: str = "",
        theme_colors: dict = None,
        page_size: str = "A4",
        orientation: str = "portrait",
        scale: float = 1.0,
        continuous: bool = False,
        source_label: str = "",
    ) -> dict:
        try:
            def _do():
                try:
                    exporter.export_pdf(
                        self._last_result_cols, self._last_result_rows, filepath,
                        title=title,
                        subtitle="",
                        org_name=org_name,
                        logo_b64=logo_b64,
                        sql_display=sql_display,
                        theme_colors=theme_colors,
                        page_size=page_size,
                        orientation=orientation,
                        scale=scale,
                        continuous=continuous,
                        source_label=source_label,
                    )
                except Exception as ex:
                    print(f"[PDF export error] {ex}")
            threading.Thread(target=_do, daemon=True).start()
            return _ok(filepath)
        except Exception as e:
            return _err(e)
