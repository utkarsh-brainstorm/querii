"""
core/exporter.py
================
Export query results to CSV and PDF.

Two PDF modes:
  1. export_pdf()      — ReportLab-based, always works (classic mode)
  2. export_pdf_html() — HTML/CSS template rendered via headless Chromium;
                         falls back to export_pdf() if Chromium is unavailable.
"""

from __future__ import annotations

import csv
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
# HTML/CSS PDF renderer (Chromium headless)
# ---------------------------------------------------------------------------

_CHROMIUM_CANDIDATES = [
    "chromium-browser", "chromium", "google-chrome", "google-chrome-stable",
    "chrome",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]


def _find_chromium() -> Optional[str]:
    """Return path to a usable Chromium/Chrome binary, or None."""
    import shutil
    for c in _CHROMIUM_CANDIDATES:
        if Path(c).is_file():
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
    col_widths: Optional[Dict[str, float]] = None,   # col_name -> width%
    col_headers: Optional[Dict[str, str]]  = None,   # col_name -> display label
    col_visible: Optional[List[str]]       = None,   # list of visible col names (None = all)
    full_override: bool = False,
) -> str:
    """
    Build a complete standalone HTML string optimised for WeasyPrint PDF output.
    No external fonts, no JavaScript — everything inline.
    Custom CSS is injected AFTER the base styles so it overrides anything.
    """
    import base64

    # ── column filtering & labelling ──────────────────────────────────────────
    if col_visible is not None:
        vis_set = set(col_visible)
        columns = [c for c in columns if c in vis_set]
    col_widths  = col_widths  or {}
    col_headers = col_headers or {}

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
        return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

    # ── table rows HTML ───────────────────────────────────────────────────────
    def _th(c: str) -> str:
        label = col_headers.get(c, c)
        w = col_widths.get(c)
        style = f' style="width:{w}%"' if w else ''
        return f"<th{style}>{he(label)}</th>"

    def _td(c: str, row: dict) -> str:
        w = col_widths.get(c)
        style = f' style="width:{w}%"' if w else ''
        return f"<td{style}>{he(str(row.get(c, '') or ''))}</td>"

    thead_cells    = "".join(_th(c) for c in columns)
    col_group      = "".join(
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
        sql_lines = he(sql_display[:2000])
        sql_block = f"""
        <section class="sql-block">
          <div class="sql-label">SQL Query</div>
          <pre class="sql-pre">{sql_lines}</pre>
        </section>"""

    # ── source / footer ───────────────────────────────────────────────────────
    footer_parts = [f"Total Records: {len(rows):,}", "Querii"]
    if source_label:
        footer_parts.insert(1, f"Source: {he(source_label)}")
    footer_html = "  |  ".join(footer_parts)

    # ── generated date ────────────────────────────────────────────────────────
    gen_date = datetime.now().strftime("%d %b %Y, %I:%M %p")

    # ── org header elements ───────────────────────────────────────────────────
    logo_img_header = f'<img src="{logo_src}" alt="Logo" class="school-logo">' if logo_src else ""
    org_display = he(org_name) if org_name else "Querii"
    wm_text = he(org_name.upper()) if org_name else "QUERII"

    # WeasyPrint note: CSS custom properties (--var) have limited support.
    # We expand all variables inline for maximum compatibility.
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{he(title)}</title>
  <style>
/* General Querii PDF CSS — reusable across organizations and reports.
   No organization names, addresses, logos, or report titles are hardcoded.
   Uses the generic class names from the general template. */

:root {{
  --paper: #ffffff;
  --screen-bg: #e7ebf0;
  --navy: #334155;
  --navy-soft: #475569;
  --gold: #b7791f;
  --text: #111827;
  --muted: #64748b;
  --border: #cbd5e1;
  --border-light: #e2e8f0;
  --row-alt: #f8fafc;
  --table-head: #e9eef5;
  --table-head-text: #243247;
  --header-bg: #f8fafc;
}}

*,
*::before,
*::after {{
  box-sizing: border-box;
}}

html,
body {{
  margin: 0;
  padding: 0;
  background: var(--paper);
  color: var(--text);
  font-family: "Segoe UI", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}}

/* Main content area. Use normal flow so long reports paginate cleanly. */
.content {{
  position: relative;
  z-index: 10;
  width: 100%;
  max-width: 100%;
  margin: 0 auto;
  padding: 12mm 14mm;
  color: var(--text);
  background: var(--paper);
  overflow-wrap: anywhere;
}}

/* =========================
   ORGANIZATION HEADER
========================= */

.school-header {{
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 88px;
  margin: 0 0 16px;
  padding: 13px 18px;
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-top: 3px solid #c5a15a;
  border-radius: 10px;
  text-align: center;
  page-break-inside: avoid;
  break-inside: avoid;
}}

.school-logo {{
  display: inline-block;
  vertical-align: middle;
  width: 68px;
  height: 68px;
  margin: 0 18px 0 0;
  object-fit: contain;
}}

.school-info {{
  display: inline-block;
  vertical-align: middle;
  max-width: calc(100% - 100px);
  text-align: center;
  overflow-wrap: anywhere;
}}

.school-info h2 {{
  margin: 0 0 5px;
  color: #26364b;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 21px;
  line-height: 1.25;
  font-weight: 800;
  overflow-wrap: anywhere;
}}

.address {{
  margin: 0;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.45;
  font-weight: 600;
  overflow-wrap: anywhere;
}}

.school-meta {{
  margin-top: 6px;
  color: var(--navy-soft);
  font-size: 9px;
  line-height: 1.4;
  font-weight: 800;
  overflow-wrap: anywhere;
}}

.school-meta span {{
  display: inline-block;
  margin: 2px 8px;
}}

/* =========================
   DOCUMENT HEADING
========================= */

.document-heading {{
  width: 100%;
  margin: 0 0 17px;
  padding: 2px 0 12px;
  text-align: center;
  border-bottom: 2px solid var(--navy-soft);
  page-break-inside: avoid;
  break-inside: avoid;
}}

.heading-accent {{
  width: 48px;
  height: 3px;
  margin: 0 auto 7px;
  background: var(--gold);
  border-radius: 4px;
}}

.title {{
  width: 100%;
  max-width: 100%;
  margin: 0;
  color: #26364b;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 25px;
  line-height: 1.25;
  font-weight: 800;
  overflow-wrap: anywhere;
  word-break: normal;
}}

.gen-date {{
  margin-top: 7px;
  color: var(--muted);
  font-size: 9px;
  font-weight: 700;
  line-height: 1.45;
  overflow-wrap: anywhere;
}}

/* =========================
   DATA TABLE
========================= */

.data-table-wrap {{
  width: 100%;
  max-width: 100%;
  min-width: 0;
  margin: 0 0 16px;
  overflow: visible;
}}

.data-table {{
  width: 100%;
  max-width: 100%;
  margin: 0 0 16px;
  border: 1px solid var(--border);
  border-collapse: separate;
  border-spacing: 0;
  border-radius: 8px;
  table-layout: auto;
  background: #fff;
  color: var(--text);
  font-size: 9px;
  line-height: 1.4;
}}

.data-table thead {{
  display: table-header-group;
}}

.data-table tfoot {{
  display: table-footer-group;
}}

.data-table tr {{
  page-break-inside: avoid;
  break-inside: avoid;
}}

.data-table th,
.data-table td {{
  min-width: 0;
  max-width: 70mm;
  padding: 7px 8px;
  text-align: left;
  vertical-align: top;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: normal;
  hyphens: auto;
}}

.data-table th {{
  background: var(--table-head);
  color: var(--table-head-text);
  font-size: 8.5px;
  line-height: 1.35;
  font-weight: 800;
  border: 0;
  border-bottom: 2px solid #c5a15a;
}}

.data-table th:first-child {{
  border-top-left-radius: 7px;
}}

.data-table th:last-child {{
  border-top-right-radius: 7px;
}}

.data-table td {{
  color: var(--text);
  border: 0;
  border-bottom: 1px solid var(--border-light);
}}

.data-table tbody tr:nth-child(even) {{
  background: var(--row-alt);
}}

.data-table tbody tr:nth-child(odd) {{
  background: #fff;
}}

.data-table tbody tr:last-child td {{
  border-bottom: 0;
}}

.data-table td a,
.data-table th a,
.data-table td code {{
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: normal;
}}

.data-table td img {{
  max-width: 100%;
  height: auto;
}}

/* =========================
   FOOTER
========================= */

.footer {{
  width: 100%;
  margin: 15px 0 0;
  padding: 9px 0 0;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 9px;
  line-height: 1.5;
  text-align: center;
  page-break-inside: avoid;
  break-inside: avoid;
  overflow-wrap: anywhere;
}}

/* Support the alternate footer class used by some report layouts. */
.report-footer {{
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 7px 14px;
  width: 100%;
  margin: 15px 0 0;
  padding: 9px 0 0;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 8.5px;
  font-weight: 700;
  line-height: 1.5;
}}

.report-footer > * {{
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}}

/* =========================
   SQL BLOCK
========================= */

.sql-block {{
  width: 100%;
  min-width: 0;
  margin: 18px 0 0;
  padding: 0;
  overflow: hidden;
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 10px;
  page-break-inside: avoid;
  break-inside: avoid;
}}

.sql-label {{
  margin: 0;
  padding: 7px 10px;
  color: #243247;
  background: var(--table-head);
  border-bottom: 2px solid #c5a15a;
  font-size: 9px;
  font-weight: 800;
}}

.sql-block pre,
.sql-pre {{
  max-width: 100%;
  margin: 0;
  padding: 10px;
  color: var(--text);
  font-family: Consolas, "Courier New", monospace;
  font-size: 8px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}}

/* =========================
   PRINT
========================= */

@page {{
  size: {css_page_size};
  margin: 12mm 14mm;
}}

@media print {{
  html,
  body {{
    width: auto;
    height: auto;
    margin: 0;
    padding: 0;
    background: #fff !important;
    overflow: visible !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }}

  .content {{
    width: auto;
    max-width: none;
    margin: 0;
    padding: 0;
    overflow: visible;
    background: #fff !important;
  }}

  .school-header,
  .document-heading,
  .footer,
  .report-footer,
  .sql-block {{
    break-inside: avoid;
    page-break-inside: avoid;
  }}

  .data-table-wrap {{
    overflow: visible !important;
  }}

  .data-table {{
    width: 100%;
    max-width: 100%;
    font-size: 8.5px;
  }}

  .data-table thead {{
    display: table-header-group;
  }}

  .data-table th {{
    background: var(--table-head) !important;
    color: var(--table-head-text) !important;
  }}

  .data-table tbody tr:nth-child(even) {{
    background: var(--row-alt) !important;
  }}

  .data-table a {{
    color: inherit;
    text-decoration: none;
  }}
}}

    /* ── Watermark (CSS-only, no JS needed) ── */
    body::before {{
      content: "{wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}";
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-28deg);
      font-size: 38pt;
      font-weight: 900;
      color: rgba(15,23,42,0.04);
      white-space: nowrap;
      pointer-events: none;
      z-index: -1;
      letter-spacing: 0.3em;
      word-spacing: 0.5em;
    }}
    /* ── Page break helpers ── */
    thead {{ display: table-header-group; }}
    tr {{ page-break-inside: avoid; }}

    /* ── CUSTOM CSS (user-injected, overrides everything above) ── */
{custom_css}
{"" if full_override else f'''
    /* Enforced Page Settings (Style Override Only) */
    @page {{
      size: {css_page_size} !important;
      margin: 18mm 14mm 14mm 14mm !important;
    }}
'''}
  </style>
</head>
<body>
  <!-- School Header -->
  <header class="school-header">
    {logo_img_header}
    <div class="school-info">
      <h2>{org_display}</h2>
    </div>
  </header>

  <!-- Document Heading -->
  <section class="document-heading">
    <div class="heading-accent"></div>
    <h1 class="title">{he(title)}</h1>
    <div class="gen-date">Generated: {gen_date}</div>
  </section>

  <!-- Data Table -->
  <div class="data-table-wrap">
    <table class="data-table">
      <colgroup>{col_group}</colgroup>
      <thead><tr>{thead_cells}</tr></thead>
      <tbody>{tbody_rows_html}</tbody>

    </table>
  </div>

  <!-- Footer -->
  <div class="report-footer">{footer_html}</div>
  {sql_block}
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
) -> None:
    """
    Render query results to a styled PDF using WeasyPrint.
    Falls back to ReportLab if WeasyPrint is unavailable.
    Errors are printed to stderr so they are visible in the app console.
    """
    try:
        import weasyprint  # noqa: F401
    except ImportError:
        print("[PDF HTML] WeasyPrint not found — falling back to ReportLab.")
        export_pdf(
            columns=columns, rows=rows, filepath=filepath,
            title=title, org_name=org_name, logo_b64=logo_b64,
            sql_display=sql_display, source_label=source_label,
            page_size=page_size, orientation=orientation,
        )
        return

    try:
        html_content = _build_pdf_html(
            columns=columns, rows=rows, title=title, org_name=org_name,
            logo_b64=logo_b64, sql_display=sql_display, source_label=source_label,
            custom_css=custom_css, page_size=page_size, orientation=orientation,
            col_widths=col_widths, col_headers=col_headers, col_visible=col_visible,
            full_override=full_override,
        )
        out_path = str(Path(filepath))
        import weasyprint as wp
        import logging
        # Suppress noisy WeasyPrint font warnings
        logging.getLogger("weasyprint").setLevel(logging.ERROR)
        logging.getLogger("fontTools").setLevel(logging.ERROR)
        doc = wp.HTML(string=html_content, base_url=None)
        doc.write_pdf(out_path)
        print(f"[PDF HTML] Saved to {out_path}")
    except Exception as exc:
        import traceback
        print(f"[PDF HTML ERROR] WeasyPrint failed: {exc}")
        traceback.print_exc()
        print("[PDF HTML] Falling back to ReportLab.")
        export_pdf(
            columns=columns, rows=rows, filepath=filepath,
            title=title, org_name=org_name, logo_b64=logo_b64,
            sql_display=sql_display, source_label=source_label,
            page_size=page_size, orientation=orientation,
        )






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
    col_headers: Optional[Dict[str, str]]  = None,
    col_visible: Optional[List[str]]       = None,
    full_override: bool = False,
) -> str:
    """Return the HTML string for in-app preview (iframe srcdoc)."""
    return _build_pdf_html(
        columns=columns, rows=rows[:100], title=title, org_name=org_name,
        logo_b64=logo_b64, sql_display=sql_display, source_label=source_label,
        custom_css=custom_css, page_size=page_size, orientation=orientation,
        col_widths=col_widths, col_headers=col_headers, col_visible=col_visible,
        full_override=full_override,
    )


# ---------------------------------------------------------------------------
# Dev-mode three-file workflow
# ---------------------------------------------------------------------------

_DEV_DIR = Path(tempfile.gettempdir()) / "querii_dev"


def write_dev_files(
    columns: List[str],
    rows: List[Dict],
    custom_css: str = "",
    title: str = "Query Results",
    org_name: str = "",
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
 *   body, .school-header, .school-logo, .school-info h2
 *   .document-heading, .heading-accent, .title, .gen-date
 *   .data-table, .data-table thead th, .data-table tbody td
 *   .data-table tbody tr.even, .data-table tbody tr.odd
 *   .report-footer, .sql-block, .sql-pre
 *
 * Override @page for {page_size}{orient_suffix}:
 *   @page {{ size: {page_size}{orient_suffix}; margin: 18mm 14mm; }}
 */

"""
    css_path.write_text(header + (custom_css or ""), encoding="utf-8")

    # 3) render.py
    script_path = _DEV_DIR / "render.py"
    script_path.write_text(f"""\
#!/usr/bin/env python3
\"\"\"Querii Dev Mode — Standalone PDF renderer. Edit data.csv + style.css then run this.\"\"\"
import csv, sys, logging
from pathlib import Path
HERE = Path(__file__).parent
sys.path.insert(0, {qpath!r})
from core.exporter import _build_pdf_html
rows, columns = [], []
with open(HERE / 'data.csv', encoding='utf-8-sig') as f:
    r = csv.DictReader(f); columns = list(r.fieldnames or []); rows = list(r)
css = (HERE / 'style.css').read_text(encoding='utf-8')
html = _build_pdf_html(columns=columns, rows=rows, title={title!r}, org_name={org_name!r},
    custom_css=css, page_size={page_size!r}, orientation={orientation!r}, full_override={full_override})
logging.getLogger('weasyprint').setLevel(logging.ERROR)
logging.getLogger('fontTools').setLevel(logging.ERROR)
import weasyprint as wp
out = HERE / 'output.pdf'
wp.HTML(string=html, base_url=None).write_pdf(str(out))
print(f'PDF saved: {{out}}')
""", encoding="utf-8")
    script_path.chmod(0o755)
    return {"dir": str(_DEV_DIR), "csv": str(csv_path), "css": str(css_path), "script": str(script_path)}


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
# PDF (ReportLab) — classic mode kept for fallback
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
) -> None:
    """Render a table to PDF using ReportLab with dynamic theming."""
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
        import base64
        import tempfile as _tmp
    except ImportError:
        raise ImportError("reportlab is required. pip install reportlab")

    out_path = str(Path(filepath))
    tc = theme_colors or {}
    c_bg     = colors.HexColor(tc.get("bg",     "#ffffff"))
    c_text   = colors.HexColor(tc.get("text",   "#1d1d1f"))
    c_head   = colors.HexColor(tc.get("head",   "#1d1d1f"))
    c_border = colors.HexColor(tc.get("border", "#d2d2d7"))
    scale = max(0.4, min(2.0, float(scale or 1.0)))
    has_logo   = bool(logo_b64)
    top_margin = int((22 if has_logo else 14) * mm * scale)
    h_margin   = int(12 * mm * scale)
    b_margin   = int(14 * mm * scale)
    PAGE_SIZES = {"A4": A4, "A3": A3, "Letter": letter}
    base_pagesize = PAGE_SIZES.get(page_size, A4)
    if orientation == "landscape":
        base_pagesize = rl_landscape(base_pagesize)
    if continuous:
        est_row_h    = int(6 * mm * scale)
        header_block = int(40 * mm * scale)
        footer_block = int(20 * mm * scale)
        buffer       = int(20 * mm)
        table_height = (len(rows) + 1) * est_row_h
        est_height   = top_margin + header_block + table_height + footer_block + b_margin + buffer
        page_w = base_pagesize[0]
        page_h = max(297 * mm, est_height)
        pagesize = (page_w, page_h)
    else:
        pagesize = base_pagesize

    class ThemeDocTemplate(SimpleDocTemplate):
        def beforePage(self) -> None:
            self.canv.saveState()
            self.canv.setFillColor(c_bg)
            self.canv.rect(0, 0, self.pagesize[0], self.pagesize[1], fill=1, stroke=0)
            self.canv.restoreState()

    doc = ThemeDocTemplate(
        out_path, pagesize=pagesize,
        rightMargin=h_margin, leftMargin=h_margin,
        topMargin=top_margin, bottomMargin=b_margin,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("QTitle", parent=styles["Normal"],
        fontSize=int(13*scale), fontName="Helvetica-Bold",
        textColor=c_head, spaceAfter=3, alignment=TA_CENTER)
    sub_style   = ParagraphStyle("QSub", parent=styles["Normal"],
        fontSize=int(8*scale), fontName="Helvetica",
        textColor=c_text, spaceAfter=2, alignment=TA_CENTER)
    cell_style  = ParagraphStyle("QCell", parent=styles["Normal"],
        fontSize=int(7*scale), fontName="Helvetica",
        textColor=c_text, wordWrap="CJK")
    hdr_cell_style = ParagraphStyle("QHdrCell", parent=styles["Normal"],
        fontSize=int(7*scale), fontName="Helvetica-Bold",
        textColor=c_bg, wordWrap="CJK")
    story: list = []
    _logo_tmp = None
    if logo_b64:
        try:
            from reportlab.platypus import Image as RLImage
            from reportlab.lib.utils import ImageReader
            import base64 as b64
            logo_bytes = b64.b64decode(logo_b64)
            _logo_tmp  = _tmp.NamedTemporaryFile(delete=False, suffix=".png")
            _logo_tmp.write(logo_bytes); _logo_tmp.flush(); _logo_tmp.close()
            img_reader = ImageReader(_logo_tmp.name)
            img_w, img_h = img_reader.getSize()
            aspect = img_w / float(img_h)
            target_h = int(22 * mm * scale)
            target_w = target_h * aspect
            page_w_avail = pagesize[0] - 2 * h_margin
            if target_w > page_w_avail:
                target_w = page_w_avail; target_h = int(target_w / aspect)
            img = RLImage(_logo_tmp.name, width=target_w, height=target_h)
            img.hAlign = "CENTER"
            story.append(img)
            story.append(Spacer(1, int(2*mm)))
        except Exception:
            pass
    story.append(Paragraph(title, title_style))
    story.append(Paragraph(f"Generated: {datetime.now().strftime('%d %b %Y, %I:%M %p')}", sub_style))
    story.append(Spacer(1, int(3*mm)))
    story.append(HRFlowable(width="100%", thickness=1, color=c_border))
    story.append(Spacer(1, int(3*mm)))
    if not rows:
        story.append(Paragraph("No records found.", styles["Normal"]))
        doc.build(story); return
    header_row = [Paragraph(f"<b>{col}</b>", hdr_cell_style) for col in columns]
    data = [header_row]
    for row in rows:
        data.append([Paragraph(str(row.get(col, "") or ""), cell_style) for col in columns])
    avail_w    = pagesize[0] - 2 * h_margin
    col_w      = avail_w / max(len(columns), 1)
    col_widths = [col_w] * len(columns)
    pad = int(4 * scale)
    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND",    (0,0), (-1,0),  c_head),
        ("TEXTCOLOR",     (0,0), (-1,0),  c_bg),
        ("FONTNAME",      (0,0), (-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0,0), (-1,0),  int(7*scale)),
        ("BOTTOMPADDING", (0,0), (-1,0),  pad),
        ("TOPPADDING",    (0,0), (-1,0),  pad),
        ("FONTNAME",      (0,1), (-1,-1), "Helvetica"),
        ("FONTSIZE",      (0,1), (-1,-1), int(6*scale)),
        ("BOTTOMPADDING", (0,1), (-1,-1), pad-1),
        ("TOPPADDING",    (0,1), (-1,-1), pad-1),
        ("LEFTPADDING",   (0,0), (-1,-1), pad),
        ("RIGHTPADDING",  (0,0), (-1,-1), pad),
        ("GRID",          (0,0), (-1,-1), 0.25, c_border),
        ("VALIGN",        (0,0), (-1,-1), "MIDDLE"),
        ("ROUNDEDCORNERS",[5]),
    ]))
    story.append(table)
    story.append(Spacer(1, int(4*mm)))
    footer_parts = [f"Total Records: {len(rows)}", "Querii"]
    if source_label:
        footer_parts.insert(1, f"Source: {source_label}")
    story.append(Paragraph("  |  ".join(footer_parts), sub_style))
    if sql_display:
        sql_style = ParagraphStyle("QSql", parent=styles["Normal"],
            fontSize=int(6*scale), fontName="Courier",
            textColor=colors.HexColor("#555555"),
            spaceAfter=2, leftIndent=4, leading=int(8*scale))
        sql_lbl = ParagraphStyle("QSqlLbl", parent=styles["Normal"],
            fontSize=int(6*scale), fontName="Courier-Bold",
            textColor=colors.HexColor("#333333"), spaceAfter=1)
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#d2d2d7")))
        story.append(Spacer(1, int(2*mm)))
        story.append(Paragraph("Query:", sql_lbl))
        for line in sql_display.split("\n")[:30]:
            if line.strip():
                story.append(Paragraph(line.replace(" ", "&nbsp;"), sql_style))
    doc.build(story)
    if _logo_tmp is not None:
        try: os.unlink(_logo_tmp.name)
        except Exception: pass
