"""
core/importer.py
================
Generic flat-sheet reader for Querii.

Reads any XLS, XLSX, or CSV file and returns:
  - A list of ColumnInfo objects (with inferred types)
  - A list of rows as lists of raw strings

The caller (db.py) then creates a table and inserts the rows.
"""

from __future__ import annotations

import csv
import io
import os
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from core.schema import ColumnInfo, infer_type, sanitise_identifier


# ---------------------------------------------------------------------------
# Public result type
# ---------------------------------------------------------------------------

@dataclass
class ImportPreview:
    """Everything needed to preview and confirm an import."""
    filename:    str
    columns:     List[ColumnInfo]
    row_count:   int              # total data rows (excluding header)
    sample_rows: List[List[str]] = field(default_factory=list)  # first 5 rows
    warnings:    List[str]       = field(default_factory=list)


# ---------------------------------------------------------------------------
# Raw row readers
# ---------------------------------------------------------------------------

def _read_xls(filepath: str, header_row_index: int = 0) -> Tuple[List[str], List[List[str]]]:
    """Read an old-style .xls file. Returns (headers, data_rows)."""
    import xlrd
    wb = xlrd.open_workbook(filepath)
    ws = wb.sheets()[0]

    if ws.nrows == 0:
        raise ValueError("The file appears to be empty.")

    headers = []
    for c in range(ws.ncols):
        v = ws.cell_value(header_row_index, c)
        headers.append(str(v).strip() if v != "" else f"col_{c+1}")

    rows = []
    for r in range(header_row_index + 1, ws.nrows):
        row = []
        for c in range(ws.ncols):
            v = ws.cell_value(r, c)
            row.append(str(v).strip() if v != "" else "")
        rows.append(row)

    return headers, rows


def _read_xlsx(filepath: str, header_row_index: int = 0) -> Tuple[List[str], List[List[str]]]:
    """Read an .xlsx / .xlsm file using openpyxl."""
    import openpyxl
    wb = openpyxl.load_workbook(filepath, data_only=True)
    ws = wb.active

    all_rows = []
    for row in ws.iter_rows(values_only=True):
        all_rows.append([str(c).strip() if c is not None else "" for c in row])

    if len(all_rows) <= header_row_index:
        raise ValueError("The file appears to be empty or the header row index is out of range.")

    headers = all_rows[header_row_index]
    # Replace empty header cells
    for i, h in enumerate(headers):
        if not h or h.lower() in ("none", "nan", ""):
            headers[i] = f"col_{i+1}"

    data_rows = all_rows[header_row_index + 1:]
    return headers, data_rows


def _read_csv(filepath: str, header_row_index: int = 0) -> Tuple[List[str], List[List[str]]]:
    """Read a CSV file. Auto-detects delimiter."""
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        sample = f.read(4096)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel  # fallback to comma

        reader = csv.reader(f, dialect)
        all_rows = [row for row in reader]

    if len(all_rows) <= header_row_index:
        raise ValueError("The CSV file appears to be empty or the header row index is out of range.")

    headers = [h.strip() or f"col_{i+1}" for i, h in enumerate(all_rows[header_row_index])]
    data_rows = all_rows[header_row_index + 1:]
    return headers, data_rows


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def preview_file(
    filepath: str,
    header_row_index: int = 0,
) -> ImportPreview:
    """
    Read a file and return an ImportPreview with inferred column types
    and sample rows. Does NOT write anything to the database.

    Supports: .xls, .xlsx, .xlsm, .csv
    Raises ValueError on unsupported format or read error.
    """
    filename = os.path.basename(filepath)
    ext = os.path.splitext(filepath)[1].lower()

    try:
        if ext == ".xls":
            headers, data_rows = _read_xls(filepath, header_row_index)
        elif ext in (".xlsx", ".xlsm"):
            headers, data_rows = _read_xlsx(filepath, header_row_index)
        elif ext == ".csv":
            headers, data_rows = _read_csv(filepath, header_row_index)
        else:
            raise ValueError(
                f"Unsupported file format '{ext}'. "
                "Supported formats: .xls, .xlsx, .xlsm, .csv"
            )
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"Cannot read '{filename}': {e}")

    if not headers:
        raise ValueError("No columns detected in the file.")

    # Remove completely empty trailing columns
    while headers and not headers[-1].strip():
        headers.pop()
    ncols = len(headers)

    # Pad / trim every data row to ncols
    cleaned_rows = []
    for row in data_rows:
        # Skip rows that are entirely empty
        padded = (row + [""] * ncols)[:ncols]
        if any(c.strip() for c in padded):
            cleaned_rows.append(padded)

    warnings: List[str] = []
    if not cleaned_rows:
        warnings.append("No data rows found after the header row.")

    # Infer column types from the first 200 rows (for speed)
    sample_for_inference = cleaned_rows[:200]
    seen_names: set = set()
    columns: List[ColumnInfo] = []
    for i, raw_name in enumerate(headers):
        col_samples = [row[i] for row in sample_for_inference if row[i].strip()]
        sql_type = infer_type(col_samples)
        sqlite_name = sanitise_identifier(raw_name or f"col_{i+1}", existing=seen_names)
        columns.append(ColumnInfo(
            raw_name=raw_name,
            sqlite_name=sqlite_name,
            sql_type=sql_type,
            samples=col_samples[:5],
        ))

    return ImportPreview(
        filename=filename,
        columns=columns,
        row_count=len(cleaned_rows),
        sample_rows=cleaned_rows[:5],
        warnings=warnings,
    )


def read_all_rows(
    filepath: str,
    header_row_index: int = 0,
    ncols: int = 0,
) -> List[List[str]]:
    """
    Read all data rows from the file (after the header).
    Used by db.import_sheet() after the preview is confirmed.
    """
    ext = os.path.splitext(filepath)[1].lower()
    if ext == ".xls":
        _, rows = _read_xls(filepath, header_row_index)
    elif ext in (".xlsx", ".xlsm"):
        _, rows = _read_xlsx(filepath, header_row_index)
    elif ext == ".csv":
        _, rows = _read_csv(filepath, header_row_index)
    else:
        raise ValueError(f"Unsupported format: {ext}")

    cleaned = []
    for row in rows:
        padded = (row + [""] * ncols)[:ncols] if ncols else row
        if any(c.strip() for c in padded):
            cleaned.append(padded)
    return cleaned
