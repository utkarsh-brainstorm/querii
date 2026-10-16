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

def _format_cell_val(val) -> str:
    """Format an Excel cell value cleanly to a string."""
    if val is None:
        return ""
    if isinstance(val, float) and val.is_integer():
        return str(int(val))
    return str(val).strip()


def _read_xls(filepath: str, header_row_index: int = 0) -> Tuple[List[str], List[List[str]]]:
    """
    Read and convert an .xls file.
    Supports:
      - Standard binary BIFF8 .xls (xlrd)
      - XLSX files misnamed with .xls extension (openpyxl)
      - HTML tables exported as .xls (common in ERP/academic portals)
      - XML Spreadsheet 2003 (SpreadsheetML) exported as .xls
      - CSV/TSV data saved with .xls extension
    If data is complex or incompatible, raises ValueError with a clean message.
    """
    try:
        with open(filepath, "rb") as f:
            magic = f.read(4096)
    except Exception as e:
        raise ValueError(f"Cannot open file: {e}")

    # 1. Check for XLSX (Zip archive PK\x03\x04)
    if magic.startswith(b"PK\x03\x04"):
        return _read_xlsx(filepath, header_row_index)

    # 2. Check for XML Spreadsheet 2003
    if b"<?xml" in magic or b"<Workbook" in magic or b"urn:schemas-microsoft-com:office:spreadsheet" in magic:
        try:
            import xml.etree.ElementTree as ET
            tree = ET.parse(filepath)
            root = tree.getroot()
            table = root.find(".//{urn:schemas-microsoft-com:office:spreadsheet}Table")
            if table is None:
                table = root.find(".//Table")
            if table is not None:
                all_rows = []
                row_els = table.findall(".//{urn:schemas-microsoft-com:office:spreadsheet}Row") or table.findall(".//Row")
                for row_el in row_els:
                    row_data = []
                    curr_col = 0
                    cell_els = row_el.findall(".//{urn:schemas-microsoft-com:office:spreadsheet}Cell") or row_el.findall(".//Cell")
                    for cell_el in cell_els:
                        idx_attr = cell_el.attrib.get("{urn:schemas-microsoft-com:office:spreadsheet}Index") or cell_el.attrib.get("Index")
                        if idx_attr:
                            target_col = int(idx_attr) - 1
                            while curr_col < target_col:
                                row_data.append("")
                                curr_col += 1
                        data_el = cell_el.find(".//{urn:schemas-microsoft-com:office:spreadsheet}Data") or cell_el.find(".//Data")
                        val = data_el.text if data_el is not None and data_el.text else ""
                        row_data.append(str(val).strip())
                        curr_col += 1
                    if any(c for c in row_data):
                        all_rows.append(row_data)
                if len(all_rows) > header_row_index:
                    headers = [h or f"col_{i+1}" for i, h in enumerate(all_rows[header_row_index])]
                    data_rows = all_rows[header_row_index + 1:]
                    return headers, data_rows
        except Exception:
            pass

    # 3. Check for HTML tables misnamed as .xls
    lower_magic = magic.lower()
    if b"<html" in lower_magic or b"<!doctype" in lower_magic or b"<table" in lower_magic:
        try:
            from bs4 import BeautifulSoup
            with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                soup = BeautifulSoup(f.read(), "html.parser")
            all_rows = []
            for tr in soup.find_all("tr"):
                cells = [td.get_text(strip=True) for td in tr.find_all(["td", "th"])]
                if any(c for c in cells):
                    all_rows.append(cells)
            if len(all_rows) > header_row_index:
                headers = [h or f"col_{i+1}" for i, h in enumerate(all_rows[header_row_index])]
                data_rows = all_rows[header_row_index + 1:]
                return headers, data_rows
        except Exception:
            pass

    # 4. Standard binary .xls via xlrd
    try:
        import xlrd
        wb = xlrd.open_workbook(filepath)
        ws = wb.sheets()[0]
        if ws.nrows == 0:
            raise ValueError("The file appears to be empty.")

        headers = []
        for c in range(ws.ncols):
            v = ws.cell_value(header_row_index, c)
            headers.append(_format_cell_val(v) or f"col_{c+1}")

        rows = []
        for r in range(header_row_index + 1, ws.nrows):
            row = []
            for c in range(ws.ncols):
                v = ws.cell_value(r, c)
                row.append(_format_cell_val(v))
            rows.append(row)
        return headers, rows
    except ValueError:
        raise
    except Exception:
        # 5. Check if CSV / text
        try:
            return _read_csv(filepath, header_row_index)
        except Exception:
            pass

        # 6. Fallback to pandas
        try:
            import pandas as pd
            df = pd.read_excel(filepath, header=header_row_index)
            headers = [str(c).strip() for c in df.columns]
            data_rows = [[_format_cell_val(v) for v in row] for row in df.values]
            return headers, data_rows
        except Exception:
            pass

        raise ValueError("Data is not compatible. Please provide clean spreadsheet data.")


def _read_xlsx(filepath: str, header_row_index: int = 0) -> Tuple[List[str], List[List[str]]]:
    """Read an .xlsx / .xlsm file using openpyxl with fallback."""
    try:
        import openpyxl
        wb = openpyxl.load_workbook(filepath, data_only=True)
        ws = wb.active

        all_rows = []
        for row in ws.iter_rows(values_only=True):
            all_rows.append([_format_cell_val(c) for c in row])

        if len(all_rows) <= header_row_index:
            raise ValueError("The file appears to be empty or the header row index is out of range.")

        headers = all_rows[header_row_index]
        # Replace empty header cells
        for i, h in enumerate(headers):
            if not h or h.lower() in ("none", "nan", ""):
                headers[i] = f"col_{i+1}"

        data_rows = all_rows[header_row_index + 1:]
        return headers, data_rows
    except ValueError:
        raise
    except Exception:
        try:
            import pandas as pd
            df = pd.read_excel(filepath, header=header_row_index)
            headers = [str(c).strip() for c in df.columns]
            data_rows = [[_format_cell_val(v) for v in row] for row in df.values]
            return headers, data_rows
        except Exception:
            pass
        raise ValueError("Data is not compatible. Please provide clean spreadsheet data.")


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



def _read_ods(filepath: str, header_row_index: int = 0) -> Tuple[List[str], List[List[str]]]:
    """Read a LibreOffice ODS file. Returns (headers, data_rows)."""
    try:
        from odf.opendocument import load as ods_load
        from odf.table import Table, TableRow, TableCell
        from odf.text import P
    except ImportError:
        raise ValueError(
            "The 'odfpy' package is required to import ODS files. "
            "Run: pip install odfpy"
        )

    doc = ods_load(filepath)
    sheets = doc.spreadsheet.getElementsByType(Table)
    if not sheets:
        raise ValueError("No sheets found in ODS file.")
    sheet = sheets[0]

    all_rows: List[List[str]] = []
    for tr in sheet.getElementsByType(TableRow):
        cells = tr.getElementsByType(TableCell)
        row: List[str] = []
        for cell in cells:
            # Handle repeat attribute
            repeat = int(cell.getAttribute("numbercolumnsrepeated") or 1)
            ps = cell.getElementsByType(P)
            val = " ".join(
                "".join(str(t) for t in p.childNodes if hasattr(t, "data")) for p in ps
            ).strip()
            row.extend([val] * repeat)
        # Trim trailing empties
        while row and not row[-1].strip():
            row.pop()
        all_rows.append(row)

    # Trim trailing empty rows
    while all_rows and not any(c.strip() for c in all_rows[-1]):
        all_rows.pop()

    if len(all_rows) <= header_row_index:
        raise ValueError("ODS file appears to be empty.")

    headers = all_rows[header_row_index]
    for i, h in enumerate(headers):
        if not h.strip():
            headers[i] = f"col_{i + 1}"

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

    Supports: .xls, .xlsx, .xlsm, .ods, .csv
    Raises ValueError on unsupported format or read error.
    """
    filename = os.path.basename(filepath)
    ext = os.path.splitext(filepath)[1].lower()

    try:
        if ext == ".xls":
            headers, data_rows = _read_xls(filepath, header_row_index)
        elif ext in (".xlsx", ".xlsm"):
            headers, data_rows = _read_xlsx(filepath, header_row_index)
        elif ext == ".ods":
            headers, data_rows = _read_ods(filepath, header_row_index)
        elif ext == ".csv":
            headers, data_rows = _read_csv(filepath, header_row_index)
        else:
            raise ValueError(
                f"Unsupported file format '{ext}'. "
                "Supported formats: .xls, .xlsx, .xlsm, .ods, .csv"
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
    elif ext == ".ods":
        _, rows = _read_ods(filepath, header_row_index)
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
