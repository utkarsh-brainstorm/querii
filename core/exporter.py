"""
core/exporter.py
================
Export query results to CSV and PDF.

Engines:
  1. export_pdf_rust() — Blazing-fast native Rust PDF engine (sub-50ms, executive vector layout)
  2. export_pdf_html() — Modern HTML/CSS template rendered via headless Chromium/Chrome
  3. export_pdf()      — Rust native engine with ReportLab fallback
"""

from __future__ import annotations

import base64
import csv
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------

def export_csv(columns: List[str], rows: List[Dict], filepath: str) -> None:
    """Write columns + rows to a CSV file."""
    out = Path(filepath)
    with out.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({col: row.get(col, "") for col in columns})


# ---------------------------------------------------------------------------
# Rust Native PDF Engine (Blazing Fast, sub-50ms)
# ---------------------------------------------------------------------------

def _find_rust_engine() -> Optional[str]:
    """Find the compiled native Rust PDF generator binary."""
    here = Path(__file__).parent
    candidates = [
        here / "querii-pdf",
        here / "rust_engine" / "target" / "release" / "rust_engine",
        here / "rust_engine" / "target" / "debug" / "rust_engine",
        Path("/home/heisenberg/BuilderValley/querii/core/querii-pdf"),
    ]
    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    return None


def export_pdf_rust(
    columns: List[str],
    rows: List[Dict],
    filepath: str,
    title: str = "Query Results",
    org_name: str = "",
    source_label: str = "",
    sql_display: str = "",
    page_size: str = "A4",
    orientation: str = "portrait",
    scale: float = 1.0,
    theme: str = "modern",
    col_widths: Optional[Dict[str, float]] = None,
    col_headers: Optional[Dict[str, str]] = None,
    col_visible: Optional[List[str]] = None,
) -> bool:
    """
    Render query results to PDF using the high-performance Rust native engine.
    Returns True on success, False if binary is not found or fails.
    """
    rust_bin = _find_rust_engine()
    if not rust_bin:
        return False

    out_path = str(Path(filepath).resolve())
    job = {
        "output_path": out_path,
        "title": title or "Query Results",
        "org_name": org_name or "Querii Analytics",
        "source_label": source_label or "",
        "sql_display": sql_display or "",
        "page_size": page_size or "A4",
        "orientation": orientation or "portrait",
        "scale": scale or 1.0,
        "theme": theme or "modern",
        "columns": columns,
        "col_headers": col_headers or {},
        "col_widths": col_widths or {},
        "col_visible": col_visible,
        "rows": rows,
    }

    try:
        proc = subprocess.run(
            [rust_bin, "--stdin"],
            input=json.dumps(job),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode == 0 and Path(out_path).exists() and Path(out_path).stat().st_size > 500:
            return True
        else:
            print(f"[PDF Rust Engine Error] Exit {proc.returncode}: {proc.stderr[:300]}")
            return False
    except Exception as exc:
        print(f"[PDF Rust Engine Exception] {exc}")
        return False


# ---------------------------------------------------------------------------
# HTML/CSS PDF renderer (Chromium / Chrome headless)
# ---------------------------------------------------------------------------

_CHROMIUM_CANDIDATES = [
    # Prioritize native Google Chrome to avoid Snap sandbox / AppArmor confinement on Linux
    "google-chrome",
    "google-chrome-stable",
    "chrome",
    "chromium",
    "chromium-browser",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]


# ---------------------------------------------------------------------------
# Libron Font Embedding (Base64 WOFF2)
# ---------------------------------------------------------------------------

_FONT_DIR = Path(__file__).parent.parent / "web" / "fonts"
if not _FONT_DIR.exists():
    _FONT_DIR = Path(__file__).parent.parent / "Libron_Web"

_LIBRON_REG_B64 = ""
_LIBRON_BOLD_B64 = ""
_LIBRON_ITALIC_B64 = ""
_LIBRON_BOLD_ITALIC_B64 = ""

try:
    reg_p = _FONT_DIR / "Libron-Regular.woff2"
    bold_p = _FONT_DIR / "Libron-Bold.woff2"
    italic_p = _FONT_DIR / "Libron-Italic.woff2"
    bold_italic_p = _FONT_DIR / "Libron-BoldItalic.woff2"
    if reg_p.exists():
        _LIBRON_REG_B64 = base64.b64encode(reg_p.read_bytes()).decode("ascii")
    if bold_p.exists():
        _LIBRON_BOLD_B64 = base64.b64encode(bold_p.read_bytes()).decode("ascii")
    if italic_p.exists():
        _LIBRON_ITALIC_B64 = base64.b64encode(italic_p.read_bytes()).decode("ascii")
    if bold_italic_p.exists():
        _LIBRON_BOLD_ITALIC_B64 = base64.b64encode(bold_italic_p.read_bytes()).decode("ascii")
except Exception as _font_err:
    print(f"[Libron font] Warning loading fonts: {_font_err}")


def _find_chromium() -> Optional[str]:
    """Return path to a usable native Chromium/Chrome binary, or None."""
    import shutil
    for c in _CHROMIUM_CANDIDATES:
        if Path(c).is_file() and os.access(c, os.X_OK):
            return c
        found = shutil.which(c)
        if found:
            return found
    return None


def _build_pdf_html(
    columns: List[str],
    rows: List[Dict],
    title: str = "Query Results",
    org_name: str = "",
    logo_b64: str = "",
    sql_display: str = "",
    source_label: str = "",
    custom_css: str = "",
    page_size: str = "A4",
    orientation: str = "portrait",
    col_widths: Optional[Dict[str, float]] = None,
    col_headers: Optional[Dict[str, str]] = None,
    col_visible: Optional[List[str]] = None,
    full_override: bool = False,
    bold_data: bool = False,
    show_grid_lines: bool = False,
    is_preview: bool = False,
) -> str:
    """
    Build a complete, standalone, executive-grade HTML string for high-fidelity printing.
    Uses Libron font typography, executive masthead, and exact physical page sheet geometry.
    """
    # ── column filtering & labelling ──────────────────────────────────────────
    if col_visible is not None:
        vis_set = set(col_visible)
        columns = [c for c in columns if c in vis_set]
    col_widths = col_widths or {}
    col_headers = col_headers or {}

    total_records = len(rows)

    # In live dev preview: render page 1 only so it's super responsive and doesn't lag
    if is_preview:
        max_preview_rows = 18 if orientation == "landscape" else 26
        rows = rows[:max_preview_rows]

    # ── page dimensions for true paper geometry ──────────────────────────────
    dim_map = {
        "A4": ("210mm", "297mm"),
        "A3": ("297mm", "420mm"),
        "Letter": ("216mm", "279mm"),
    }
    pw, ph = dim_map.get(page_size, ("210mm", "297mm"))
    if orientation == "landscape":
        pw, ph = ph, pw

    # ── page size for @page rule ──────────────────────────────────────────────
    page_size_map = {"A4": "A4", "A3": "A3", "Letter": "letter"}
    css_page_size = page_size_map.get(page_size, "A4")
    if orientation == "landscape":
        css_page_size += " landscape"

    # ── logo data URI ─────────────────────────────────────────────────────────
    logo_src = ""
    if logo_b64:
        logo_src = "data:image/png;base64," + logo_b64

    # ── HTML escape ───────────────────────────────────────────────────────────
    def he(s: str) -> str:
        return (
            str(s)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )

    # ── table cells HTML ──────────────────────────────────────────────────────
    def _th(c: str) -> str:
        label = col_headers.get(c, c)
        w = col_widths.get(c)
        style = f' style="width:{w}%"' if w else ""
        handle = (
            f'<div class="col-resize-handle" data-col="{he(c)}" title="Drag to adjust width with mouse"></div>'
            if is_preview
            else ""
        )
        return f'<th{style} data-col="{he(c)}"><span class="th-content">{he(label)}</span>{handle}</th>'

    def _td(c: str, row: dict) -> str:
        val = row.get(c, "")
        if val is None:
            text = '<span class="cell-null">—</span>'
        else:
            text = he(str(val))
        w = col_widths.get(c)
        style = f' style="width:{w}%"' if w else ""
        return f"<td{style}>{text}</td>"

    thead_cells = "".join(_th(c) for c in columns)
    col_group = "".join(
        f'<col style="width:{col_widths[c]}%">' if c in col_widths else "<col>"
        for c in columns
    )

    tbody_rows_html = ""
    for i, row in enumerate(rows):
        row_class = "even" if i % 2 == 0 else "odd"
        cells = "".join(_td(c, row) for c in columns)
        tbody_rows_html += f'<tr class="{row_class}">{cells}</tr>\n'

    # ── SQL block ─────────────────────────────────────────────────────────────
    sql_block = ""
    if sql_display:
        sql_lines = he(sql_display[:3000])
        sql_block = f"""
        <section class="sql-block">
          <div class="sql-label">SQL Query</div>
          <pre class="sql-pre">{sql_lines}</pre>
        </section>"""

    # ── generated date ────────────────────────────────────────────────────────
    gen_date = datetime.now().strftime("%d %b %Y, %I:%M %p")
    org_display = he(org_name) if org_name else "Querii Executive"
    logo_markup = (
        f'<div class="report-logo-frame"><img src="{logo_src}" alt="Logo" class="report-logo"></div>'
        if logo_src
        else ""
    )
    source_item = (
        f'<div class="meta-item"><span class="meta-lbl">Dataset</span><span class="meta-val">{he(source_label)}</span></div>'
        if source_label
        else ""
    )

    body_data_weight = "700" if bold_data else "400"
    grid_lines_class = " grid-lines" if show_grid_lines else ""

    resize_script = """
  <script>
    (function initColResizer() {
      var handles = document.querySelectorAll('.col-resize-handle');
      if (!handles.length) return;
      handles.forEach(function(handle) {
        handle.addEventListener('mousedown', function(e) {
          e.preventDefault();
          e.stopPropagation();
          var th = handle.parentElement;
          var colName = handle.getAttribute('data-col');
          var table = th.closest('table');
          var startX = e.clientX;
          var startW = th.offsetWidth;
          var tableW = table.offsetWidth;
          handle.classList.add('resizing');
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';

          function onMouseMove(me) {
            var delta = me.clientX - startX;
            var newW = Math.max(20, startW + delta);
            var newPct = Math.max(2, Math.min(90, Math.round((newW / tableW) * 100)));
            th.style.width = newPct + '%';
            if (window.parent && window.parent._devOnColumnDragged) {
              window.parent._devOnColumnDragged(colName, newPct);
            }
          }

          function onMouseUp() {
            handle.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            if (window.parent && window.parent._devOnColumnDragEnd) {
              window.parent._devOnColumnDragEnd(colName);
            }
          }

          document.addEventListener('mousemove', onMouseMove);
          document.addEventListener('mouseup', onMouseUp);
        });
      });
    })();
  </script>
"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{he(title)}</title>
  <style>
    @font-face {{
      font-family: 'Libron';
      src: url('data:font/woff2;base64,{_LIBRON_REG_B64}') format('woff2');
      font-weight: 400;
      font-style: normal;
    }}
    @font-face {{
      font-family: 'Libron';
      src: url('data:font/woff2;base64,{_LIBRON_BOLD_B64}') format('woff2');
      font-weight: 700;
      font-style: normal;
    }}
    @font-face {{
      font-family: 'Libron';
      src: url('data:font/woff2;base64,{_LIBRON_ITALIC_B64}') format('woff2');
      font-weight: 400;
      font-style: italic;
    }}
    @font-face {{
      font-family: 'Libron';
      src: url('data:font/woff2;base64,{_LIBRON_BOLD_ITALIC_B64}') format('woff2');
      font-weight: 700;
      font-style: italic;
    }}

    :root {{
      --page-w: {pw};
      --page-h: {ph};
      --navy: #090d16;
      --navy-light: #1e293b;
      --accent: #2563eb;
      --accent-subtle: #eff6ff;
      --border: #e2e8f0;
      --border-dark: #cbd5e1;
      --text: #090d16;
      --text-muted: #64748b;
      --row-alt: #f8fafc;
      --table-head-bg: #090d16;
      --table-head-text: #ffffff;
      --data-font-weight: {body_data_weight};
    }}

    * {{
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }}

    html, body {{
      margin: 0;
      padding: 0;
      background: {'#cbd5e1' if is_preview else '#ffffff'};
      color: var(--text);
      font-family: 'Libron', Georgia, serif;
      font-size: 8.5pt;
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
      {'display: flex; justify-content: center; padding: 24px 16px; min-height: 100vh;' if is_preview else ''}
    }}

    /* Paper Page Sheet (Authentic Physical Preview) */
    .pdf-page-sheet {{
      width: var(--page-w);
      min-height: var(--page-h);
      max-width: var(--page-w);
      background: #ffffff;
      padding: 14mm 16mm;
      box-sizing: border-box;
      position: relative;
      {'box-shadow: 0 16px 40px rgba(15,23,42,0.18), 0 2px 6px rgba(15,23,42,0.06); border-radius: 2px;' if is_preview else ''}
    }}

    /* Premium Masthead */
    .masthead {{
      border-top: 3.5px solid var(--navy);
      padding-top: 14px;
      margin-bottom: 18px;
      border-bottom: 1.5px solid var(--navy);
      padding-bottom: 14px;
      break-inside: avoid;
    }}
    .masthead-inner {{
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
    }}
    .brand-col {{
      display: flex;
      align-items: center;
      gap: 14px;
    }}
    .report-logo-frame {{
      width: 48px;
      height: 48px;
      border: 1px solid var(--border-dark);
      border-radius: 6px;
      padding: 3px;
      background: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }}
    .report-logo {{
      width: 100%;
      height: 100%;
      object-fit: contain;
    }}
    .kicker {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 6.5pt;
      font-weight: 800;
      letter-spacing: 0.14em;
      color: var(--text-muted);
      text-transform: uppercase;
      margin-bottom: 3px;
    }}
    .org-title {{
      margin: 0;
      font-size: 19pt;
      font-weight: 700;
      color: var(--navy);
      letter-spacing: -0.015em;
      line-height: 1.15;
    }}
    .report-title {{
      margin-top: 4px;
      font-size: 11pt;
      font-weight: 400;
      color: #334155;
      line-height: 1.3;
    }}
    .meta-matrix {{
      display: flex;
      gap: 16px;
      text-align: right;
      align-items: flex-end;
      flex-shrink: 0;
    }}
    .meta-item {{
      display: flex;
      flex-direction: column;
    }}
    .meta-lbl {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 6pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #94a3b8;
      margin-bottom: 2px;
    }}
    .meta-val {{
      font-size: 8pt;
      font-weight: 700;
      color: var(--navy);
    }}
    .badge-count {{
      display: inline-block;
      padding: 3px 8px;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 7.5pt;
      font-weight: 700;
      color: #1e293b;
      white-space: nowrap;
    }}

    /* Data Table */
    .data-table-wrap {{
      width: 100%;
      margin-bottom: 16px;
    }}
    .data-table {{
      width: 100%;
      border-collapse: collapse;
      border-spacing: 0;
      font-family: 'Libron', serif;
      font-size: 8pt;
      border: 1px solid var(--border-dark);
      border-radius: 4px;
      overflow: hidden;
    }}
    .data-table thead {{
      display: table-header-group;
    }}
    .data-table thead th {{
      position: relative;
      background: var(--table-head-bg);
      color: var(--table-head-text);
      font-weight: 700;
      font-size: 7.5pt;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 8px 10px;
      text-align: left;
      border-bottom: 2px solid var(--accent);
    }}
    .data-table tbody tr {{
      break-inside: avoid;
      page-break-inside: avoid;
    }}
    .data-table tbody td {{
      padding: 6.5px 10px;
      border-bottom: 1px solid var(--border);
      color: #1e293b;
      vertical-align: middle;
      font-variant-numeric: tabular-nums;
      font-weight: var(--data-font-weight);
    }}
    .data-table tbody tr:nth-child(even) {{
      background: var(--row-alt);
    }}
    .data-table tbody tr:last-child td {{
      border-bottom: none;
    }}

    /* Vertical grid lines when enabled */
    .data-table.grid-lines th,
    .data-table.grid-lines td {{
      border-right: 1px solid var(--border-dark);
    }}
    .data-table.grid-lines th:last-child,
    .data-table.grid-lines td:last-child {{
      border-right: none;
    }}

    /* Interactive Column Resize Handles in Dev Preview */
    .col-resize-handle {{
      position: absolute;
      top: 0;
      right: -3px;
      bottom: 0;
      width: 7px;
      cursor: col-resize;
      z-index: 10;
      user-select: none;
      background: transparent;
      transition: background 0.15s;
    }}
    .col-resize-handle:hover,
    .col-resize-handle.resizing {{
      background: rgba(37, 99, 235, 0.7);
    }}

    /* Footer */
    .report-footer {{
      margin-top: 14px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      font-size: 7.5pt;
      color: var(--text-muted);
      font-weight: 600;
      break-inside: avoid;
    }}

    /* SQL Box */
    .sql-block {{
      margin-top: 14px;
      background: #f8fafc;
      border: 1px solid var(--border-dark);
      border-radius: 6px;
      padding: 8px 12px;
      break-inside: avoid;
    }}
    .sql-label {{
      font-size: 7pt;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--text-muted);
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }}
    .sql-pre {{
      margin: 0;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 7pt;
      color: #334155;
      white-space: pre-wrap;
      word-break: break-all;
    }}

    /* Print Rules */
    @page {{
      size: {css_page_size};
      margin: 12mm 14mm 14mm 14mm;
    }}
    @media print {{
      html, body {{
        background: #ffffff !important;
        padding: 0 !important;
        margin: 0 !important;
        display: block !important;
      }}
      .pdf-page-sheet {{
        width: 100% !important;
        max-width: 100% !important;
        min-height: 0 !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
      }}
      .col-resize-handle {{
        display: none !important;
      }}
      .data-table thead {{
        display: table-header-group;
      }}
    }}

    /* ── USER CUSTOM CSS ── */
{custom_css}
{"" if full_override else f'''
    /* Enforced Page Settings */
    @page {{
      size: {css_page_size} !important;
      margin: 12mm 14mm 14mm 14mm !important;
    }}
'''}
  </style>
</head>
<body>
  <main class="pdf-page-sheet">
    <header class="masthead">
      <div class="masthead-inner">
        <div class="brand-col">
          {logo_markup}
          <div>
            <div class="kicker">EXECUTIVE AUDIT DISPATCH • CONFIDENTIAL</div>
            <h1 class="org-title">{org_display}</h1>
            <div class="report-title">{he(title)}</div>
          </div>
        </div>
        <div class="meta-matrix">
          <div class="meta-item">
            <span class="meta-lbl">Date Issued</span>
            <span class="meta-val">{gen_date}</span>
          </div>
          {source_item}
          <div class="meta-item">
            <span class="meta-lbl">Total Output</span>
            <span class="badge-count">{total_records:,} Records</span>
          </div>
        </div>
      </div>
    </header>

    <div class="data-table-wrap">
      <table class="data-table{grid_lines_class}">
        <colgroup>{col_group}</colgroup>
        <thead><tr>{thead_cells}</tr></thead>
        <tbody>{tbody_rows_html}</tbody>
      </table>
    </div>

    <footer class="report-footer">
      <div>Querii  •  Executive Analytics Platform</div>
      <div>Total Records: {total_records:,}  •  Page 1</div>
    </footer>

    {sql_block}
  </main>
  {resize_script if is_preview else ""}
</body>
</html>"""
    return html


def export_pdf_html(
    columns: List[str],
    rows: List[Dict],
    filepath: str,
    title: str = "Query Results",
    org_name: str = "",
    logo_b64: str = "",
    sql_display: str = "",
    source_label: str = "",
    custom_css: str = "",
    page_size: str = "A4",
    orientation: str = "portrait",
    col_widths: Dict[str, float] = None,
    col_headers: Dict[str, str] = None,
    col_visible: List[str] = None,
    full_override: bool = False,
    bold_data: bool = False,
    show_grid_lines: bool = False,
) -> None:
    """
    Render query results to PDF using headless native Chromium/Chrome.
    Falls back to export_pdf() (which uses Rust native engine) if Chromium is unavailable.
    """
    chromium = _find_chromium()
    if not chromium:
        print("[PDF HTML] Chromium not found — using fast native Rust/ReportLab engine.")
        export_pdf(
            columns=columns, rows=rows, filepath=filepath,
            title=title, org_name=org_name, logo_b64=logo_b64,
            sql_display=sql_display, source_label=source_label,
            page_size=page_size, orientation=orientation,
            col_widths=col_widths, col_headers=col_headers, col_visible=col_visible,
        )
        return

    html_content = _build_pdf_html(
        columns=columns, rows=rows, title=title, org_name=org_name,
        logo_b64=logo_b64, sql_display=sql_display, source_label=source_label,
        custom_css=custom_css, page_size=page_size, orientation=orientation,
        col_widths=col_widths, col_headers=col_headers, col_visible=col_visible,
        full_override=full_override, bold_data=bold_data, show_grid_lines=show_grid_lines,
        is_preview=False,
    )

    out_path = str(Path(filepath).resolve())

    # Write HTML to temp file
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".html", encoding="utf-8", delete=False
    ) as tmp:
        tmp.write(html_content)
        tmp_html = tmp.name

    try:
        cmd = [
            chromium,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            f"--print-to-pdf={out_path}",
            "--no-pdf-header-footer",
            f"file://{tmp_html}",
        ]
        result = subprocess.run(
            cmd,
            timeout=45,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 or not Path(out_path).exists() or Path(out_path).stat().st_size < 500:
            raise RuntimeError(f"Chromium exit {result.returncode}: {result.stderr[:300]}")
        print(f"[PDF HTML] Successfully exported to {out_path} via Chromium.")
    except Exception as exc:
        print(f"[PDF HTML] Chromium error: {exc}. Falling back to Rust/ReportLab engine.")
        export_pdf(
            columns=columns, rows=rows, filepath=filepath,
            title=title, org_name=org_name, logo_b64=logo_b64,
            sql_display=sql_display, source_label=source_label,
            page_size=page_size, orientation=orientation,
            col_widths=col_widths, col_headers=col_headers, col_visible=col_visible,
        )
    finally:
        try:
            os.unlink(tmp_html)
        except Exception:
            pass


def get_pdf_html_preview(
    columns: List[str],
    rows: List[Dict],
    title: str = "Query Results",
    org_name: str = "",
    logo_b64: str = "",
    sql_display: str = "",
    source_label: str = "",
    custom_css: str = "",
    page_size: str = "A4",
    orientation: str = "portrait",
    col_widths: Optional[Dict[str, float]] = None,
    col_headers: Optional[Dict[str, str]] = None,
    col_visible: Optional[List[str]] = None,
    full_override: bool = False,
    bold_data: bool = False,
    show_grid_lines: bool = False,
) -> str:
    """Return the HTML string for in-app preview (iframe srcdoc) with exact paper geometry."""
    return _build_pdf_html(
        columns=columns, rows=rows, title=title, org_name=org_name,
        logo_b64=logo_b64, sql_display=sql_display, source_label=source_label,
        custom_css=custom_css, page_size=page_size, orientation=orientation,
        col_widths=col_widths, col_headers=col_headers, col_visible=col_visible,
        full_override=full_override, bold_data=bold_data, show_grid_lines=show_grid_lines,
        is_preview=True,
    )



# ---------------------------------------------------------------------------
# Dev-mode three-file workflow
# ---------------------------------------------------------------------------

_DEV_DIR = Path(tempfile.gettempdir()) / "querii_dev"


def open_dev_files(
    columns: List[str],
    rows: List[Dict],
    title: str = "Query Results",
    org_name: str = "",
    custom_css: str = "",
    page_size: str = "A4",
    orientation: str = "portrait",
    querii_path: str = "",
    full_override: bool = False,
) -> dict:
    """Write data.csv, style.css, render.py to the temporary dev directory."""
    import csv as csv_mod
    _DEV_DIR.mkdir(parents=True, exist_ok=True)
    qpath = querii_path or str(Path(__file__).parent.parent)
    orient_suffix = " landscape" if orientation == "landscape" else ""

    # 1) data.csv
    csv_path = _DEV_DIR / "data.csv"
    with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv_mod.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        for row in rows:
            w.writerow({c: row.get(c, "") for c in columns})

    # 2) style.css
    css_path = _DEV_DIR / "style.css"
    header = f"""\
/*
 * Querii Dev Mode — Custom CSS
 * Page: {page_size} {orientation}
 *
 * Styleable classes:
 *   .report-header, .report-logo, .org-title, .report-title, .gen-date
 *   .badge, .badge-records, .badge-source
 *   .data-table, .data-table thead th, .data-table tbody td
 *   .data-table tbody tr.even, .data-table tbody tr.odd
 *   .report-footer, .sql-block, .sql-pre
 *
 * Override @page for {page_size}{orient_suffix}:
 *   @page {{ size: {page_size}{orient_suffix}; margin: 12mm 14mm; }}
 */

"""
    css_path.write_text(header + (custom_css or ""), encoding="utf-8")

    # 3) render.py
    script_path = _DEV_DIR / "render.py"
    script_path.write_text(f"""\
#!/usr/bin/env python3
\"\"\"Querii Dev Mode — Fast Standalone PDF renderer using Chromium.\"\"\"
import csv, sys, subprocess
from pathlib import Path
HERE = Path(__file__).parent
sys.path.insert(0, {qpath!r})
from core.exporter import export_pdf_html

rows, columns = [], []
with open(HERE / 'data.csv', encoding='utf-8-sig') as f:
    r = csv.DictReader(f); columns = list(r.fieldnames or []); rows = list(r)
css = (HERE / 'style.css').read_text(encoding='utf-8')
out = HERE / 'output.pdf'

export_pdf_html(
    columns=columns, rows=rows, filepath=str(out),
    title={title!r}, org_name={org_name!r},
    custom_css=css, page_size={page_size!r}, orientation={orientation!r},
    full_override={full_override}
)
print(f'PDF saved: {{out}}')
""", encoding="utf-8")
    script_path.chmod(0o755)
    return {"dir": str(_DEV_DIR), "csv": str(csv_path), "css": str(css_path), "script": str(script_path)}


write_dev_files = open_dev_files


def read_dev_file(name: str) -> str:
    allowed = {"data.csv", "style.css", "render.py"}
    if name not in allowed:
        raise ValueError(f"Unknown dev file: {name}")
    p = _DEV_DIR / name
    return p.read_text(encoding="utf-8") if p.exists() else ""


def write_dev_file_content(name: str, content: str) -> None:
    allowed = {"data.csv", "style.css", "render.py"}
    if name not in allowed:
        raise ValueError(f"Unknown dev file: {name}")
    _DEV_DIR.mkdir(parents=True, exist_ok=True)
    (_DEV_DIR / name).write_text(content, encoding="utf-8")


# ---------------------------------------------------------------------------
# PDF Main Exporter: Rust Native Engine (Primary) + ReportLab (Fallback)
# ---------------------------------------------------------------------------

def export_pdf(
    columns: List[str],
    rows: List[Dict],
    filepath: str,
    title: str = "Query Results",
    subtitle: str = "",
    org_name: str = "",
    logo_b64: str = "",
    sql_display: str = "",
    theme_colors: Optional[dict] = None,
    page_size: str = "A4",
    orientation: str = "portrait",
    scale: float = 1.0,
    continuous: bool = False,
    source_label: str = "",
    col_widths: Optional[Dict[str, float]] = None,
    col_headers: Optional[Dict[str, str]] = None,
    col_visible: Optional[List[str]] = None,
) -> None:
    """
    Render query results to PDF.
    First tries the ultra-fast native Rust engine (<50ms).
    Falls back to ReportLab classic renderer if Rust engine is unavailable.
    """
    # 1. Try Rust native engine
    if export_pdf_rust(
        columns=columns,
        rows=rows,
        filepath=filepath,
        title=title,
        org_name=org_name,
        source_label=source_label,
        sql_display=sql_display,
        page_size=page_size,
        orientation=orientation,
        scale=scale,
        theme="modern",
        col_widths=col_widths,
        col_headers=col_headers,
        col_visible=col_visible,
    ):
        print(f"[PDF Export] Successfully exported to {filepath} using native Rust engine.")
        return

    # 2. ReportLab Fallback
    print(f"[PDF Export] Rust engine unavailable; using ReportLab fallback.")
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, A3, letter
        from reportlab.lib.pagesizes import landscape as rl_landscape
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle,
            Paragraph, Spacer, HRFlowable,
        )
        from reportlab.lib.enums import TA_CENTER
        import tempfile as _tmp
    except ImportError:
        raise ImportError("Neither querii-pdf nor reportlab is available.")

    out_path = str(Path(filepath).resolve())
    tc = theme_colors or {}
    c_bg = colors.HexColor(tc.get("bg", "#ffffff"))
    c_text = colors.HexColor(tc.get("text", "#0f172a"))
    c_head = colors.HexColor(tc.get("head", "#0f172a"))
    c_border = colors.HexColor(tc.get("border", "#cbd5e1"))
    scale = max(0.4, min(2.0, float(scale or 1.0)))

    has_logo = bool(logo_b64)
    top_margin = int((20 if has_logo else 14) * mm * scale)
    h_margin = int(12 * mm * scale)
    b_margin = int(14 * mm * scale)

    PAGE_SIZES = {"A4": A4, "A3": A3, "Letter": letter}
    base_pagesize = PAGE_SIZES.get(page_size, A4)
    if orientation == "landscape":
        base_pagesize = rl_landscape(base_pagesize)

    if continuous:
        est_row_h = int(6 * mm * scale)
        header_block = int(40 * mm * scale)
        footer_block = int(20 * mm * scale)
        buffer = int(20 * mm)
        table_height = (len(rows) + 1) * est_row_h
        est_height = top_margin + header_block + table_height + footer_block + b_margin + buffer
        page_w = base_pagesize[0]
        page_h = max(297 * mm, est_height)
        pagesize = (page_w, page_h)
    else:
        pagesize = base_pagesize

    doc = SimpleDocTemplate(
        out_path, pagesize=pagesize,
        rightMargin=h_margin, leftMargin=h_margin,
        topMargin=top_margin, bottomMargin=b_margin,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "QTitle", parent=styles["Normal"],
        fontSize=int(14 * scale), fontName="Helvetica-Bold",
        textColor=c_head, spaceAfter=3, alignment=TA_CENTER
    )
    sub_style = ParagraphStyle(
        "QSub", parent=styles["Normal"],
        fontSize=int(8 * scale), fontName="Helvetica",
        textColor=c_text, spaceAfter=2, alignment=TA_CENTER
    )
    cell_style = ParagraphStyle(
        "QCell", parent=styles["Normal"],
        fontSize=int(7.5 * scale), fontName="Helvetica",
        textColor=c_text, wordWrap="CJK"
    )
    hdr_cell_style = ParagraphStyle(
        "QHdrCell", parent=styles["Normal"],
        fontSize=int(7.5 * scale), fontName="Helvetica-Bold",
        textColor=colors.white, wordWrap="CJK"
    )

    story: list = []
    _logo_tmp = None
    if logo_b64:
        try:
            from reportlab.platypus import Image as RLImage
            from reportlab.lib.utils import ImageReader
            import base64 as b64
            logo_bytes = b64.b64decode(logo_b64)
            _logo_tmp = _tmp.NamedTemporaryFile(delete=False, suffix=".png")
            _logo_tmp.write(logo_bytes)
            _logo_tmp.flush()
            _logo_tmp.close()
            img_reader = ImageReader(_logo_tmp.name)
            img_w, img_h = img_reader.getSize()
            aspect = img_w / float(img_h)
            target_h = int(20 * mm * scale)
            target_w = target_h * aspect
            page_w_avail = pagesize[0] - 2 * h_margin
            if target_w > page_w_avail:
                target_w = page_w_avail
                target_h = int(target_w / aspect)
            img = RLImage(_logo_tmp.name, width=target_w, height=target_h)
            img.hAlign = "CENTER"
            story.append(img)
            story.append(Spacer(1, int(2 * mm)))
        except Exception:
            pass

    display_title = title or "Query Results"
    if org_name:
        story.append(Paragraph(org_name.upper(), sub_style))
    story.append(Paragraph(display_title, title_style))
    story.append(Paragraph(f"Generated: {datetime.now().strftime('%d %b %Y, %I:%M %p')}", sub_style))
    story.append(Spacer(1, int(2 * mm)))
    story.append(HRFlowable(width="100%", thickness=1, color=c_border))
    story.append(Spacer(1, int(3 * mm)))

    if not rows:
        story.append(Paragraph("No records found.", styles["Normal"]))
        doc.build(story)
        return

    # Filter columns
    active_cols = columns
    if col_visible:
        vis_set = set(col_visible)
        active_cols = [c for c in columns if c in vis_set]

    headers_dict = col_headers or {}
    header_row = [
        Paragraph(f"<b>{he(headers_dict.get(col, col))}</b>", hdr_cell_style)
        for col in active_cols
    ]
    data = [header_row]
    for row in rows:
        data.append([
            Paragraph(he(str(row.get(col, "") if row.get(col) is not None else "—")), cell_style)
            for col in active_cols
        ])

    avail_w = pagesize[0] - 2 * h_margin
    col_w = avail_w / max(len(active_cols), 1)
    col_widths_list = [col_w] * len(active_cols)
    pad = int(4 * scale)

    table = Table(data, colWidths=col_widths_list, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), c_head),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), int(7.5 * scale)),
        ("BOTTOMPADDING", (0, 0), (-1, 0), pad + 1),
        ("TOPPADDING", (0, 0), (-1, 0), pad + 1),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 1), (-1, -1), int(7 * scale)),
        ("BOTTOMPADDING", (0, 1), (-1, -1), pad),
        ("TOPPADDING", (0, 1), (-1, -1), pad),
        ("LEFTPADDING", (0, 0), (-1, -1), pad),
        ("RIGHTPADDING", (0, 0), (-1, -1), pad),
        ("GRID", (0, 0), (-1, -1), 0.35, c_border),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
    ]))
    story.append(table)
    story.append(Spacer(1, int(4 * mm)))

    footer_parts = [f"Total Records: {len(rows):,}", "Querii Analytics"]
    if source_label:
        footer_parts.insert(1, f"Source: {source_label}")
    story.append(Paragraph("  |  ".join(footer_parts), sub_style))

    if sql_display:
        sql_style = ParagraphStyle(
            "QSql", parent=styles["Normal"],
            fontSize=int(6.5 * scale), fontName="Courier",
            textColor=colors.HexColor("#475569"),
            spaceAfter=2, leftIndent=4, leading=int(8 * scale)
        )
        sql_lbl = ParagraphStyle(
            "QSqlLbl", parent=styles["Normal"],
            fontSize=int(6.5 * scale), fontName="Courier-Bold",
            textColor=colors.HexColor("#1e293b"), spaceAfter=1
        )
        story.append(HRFlowable(width="100%", thickness=0.5, color=c_border))
        story.append(Spacer(1, int(2 * mm)))
        story.append(Paragraph("SQL Query:", sql_lbl))
        for line in sql_display.split("\n")[:25]:
            if line.strip():
                story.append(Paragraph(he(line).replace(" ", "&nbsp;"), sql_style))

    doc.build(story)
    if _logo_tmp is not None:
        try:
            os.unlink(_logo_tmp.name)
        except Exception:
            pass
