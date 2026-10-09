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
) -> str:
    """
    Build a complete standalone HTML string optimised for WeasyPrint PDF output.
    No external fonts, no JavaScript — everything inline.
    Custom CSS is injected AFTER the base styles so it overrides anything.
    """
    import base64

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
    thead_cells = "".join(f"<th>{he(c)}</th>" for c in columns)
    tbody_rows_html = ""
    for i, row in enumerate(rows):
        row_class = "even" if i % 2 == 0 else "odd"
        cells = "".join(f"<td>{he(str(row.get(c, '') or ''))}</td>" for c in columns)
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
    /* ── Reset ── */
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 10pt;
      color: #111827;
      background: #ffffff;
    }}

    /* ── Page layout (WeasyPrint) ── */
    @page {{
      size: {css_page_size};
      margin: 18mm 14mm 14mm 14mm;
      @top-center {{
        content: "{he(org_display)} — {he(title)}";
        font-size: 8pt;
        color: #64748b;
      }}
      @bottom-right {{
        content: "Page " counter(page) " of " counter(pages);
        font-size: 8pt;
        color: #64748b;
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

    /* ── School Header ── */
    .school-header {{
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 14px 20px;
      background: #f8fafc;
      border: 1.2px solid #cbd5e1;
      border-radius: 12px;
      margin-bottom: 18px;
    }}
    .school-logo {{
      width: 68px;
      height: 68px;
      object-fit: contain;
      border-radius: 50%;
      flex-shrink: 0;
    }}
    .school-info h2 {{
      font-size: 18pt;
      font-weight: 800;
      color: #0f172a;
      margin-bottom: 3px;
    }}

    /* ── Document Heading ── */
    .document-heading {{
      text-align: center;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 10px;
      margin-bottom: 20px;
    }}
    .heading-accent {{
      width: 48px;
      height: 3px;
      background: #b7791f;
      border-radius: 4px;
      margin: 0 auto 8px;
    }}
    .title {{
      font-size: 20pt;
      font-weight: 800;
      color: #0f172a;
    }}
    .gen-date {{
      font-size: 8pt;
      color: #64748b;
      margin-top: 4px;
    }}

    /* ── Data Table ── */
    .data-table-wrap {{ width: 100%; overflow: visible; margin-bottom: 12px; }}
    .data-table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 8pt;
    }}
    .data-table thead th {{
      background: #0f172a;
      color: #ffffff;
      padding: 7px 9px;
      font-weight: 700;
      text-align: left;
      border-bottom: 2.5px solid #b7791f;
      font-size: 8pt;
    }}
    .data-table tbody td {{
      padding: 5px 9px;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: top;
      word-break: break-word;
    }}
    .data-table tbody tr.even {{ background: #f8fafc; }}
    .data-table tbody tr.odd  {{ background: #ffffff; }}
    .data-table tbody tr:last-child td {{ border-bottom: none; }}

    /* ── Footer ── */
    .report-footer {{
      text-align: center;
      font-size: 8pt;
      color: #64748b;
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid #e2e8f0;
    }}

    /* ── SQL block ── */
    .sql-block {{ margin-top: 14px; }}
    .sql-label {{ font-size: 7pt; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }}
    .sql-pre {{
      background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 5px;
      padding: 7px 9px; font-size: 7pt; font-family: monospace;
      white-space: pre-wrap; word-break: break-all; color: #334155;
    }}

    /* ── Page break helpers ── */
    thead {{ display: table-header-group; }}
    tr {{ page-break-inside: avoid; }}

    /* ── CUSTOM CSS (user-injected, overrides everything above) ── */
{custom_css}
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
) -> str:
    """Return the HTML string for in-app preview."""
    return _build_pdf_html(
        columns=columns, rows=rows[:50], title=title, org_name=org_name,
        logo_b64=logo_b64, sql_display=sql_display, source_label=source_label,
        custom_css=custom_css, page_size=page_size, orientation=orientation,
    )


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
