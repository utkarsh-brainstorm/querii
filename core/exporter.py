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
    Build a complete standalone HTML string for PDF printing.

    The HTML follows the Document_Template.html structure:
      - School/Org header with logo + org_name
      - Document heading with accent bar + title
      - Data table with rounded-corner Apple-style design
      - Optional SQL block at bottom
      - Watermark repeating text with org_name
      - Custom CSS injected into <style> after base styles
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

    # ── table rows HTML ───────────────────────────────────────────────────────
    # Escape for HTML
    def he(s: str) -> str:
        return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

    thead_cells = "".join(f"<th>{he(c)}</th>" for c in columns)
    tbody_rows = ""
    for row in rows:
        cells = "".join(f"<td>{he(str(row.get(c, '') or ''))}</td>" for c in columns)
        tbody_rows += f"<tr>{cells}</tr>\n"

    # ── watermark text ────────────────────────────────────────────────────────
    wm_text = he(org_name.upper() + " • ") if org_name else "QUERII • "

    # ── SQL block ─────────────────────────────────────────────────────────────
    sql_block = ""
    if sql_display:
        sql_lines = he(sql_display[:2000])  # cap at 2000 chars
        sql_block = f"""
        <section class="sql-block">
          <div class="sql-label">SQL Query</div>
          <pre class="sql-pre">{sql_lines}</pre>
        </section>"""

    # ── source / footer ───────────────────────────────────────────────────────
    footer_parts = [f"Total Records: {len(rows)}", "Querii"]
    if source_label:
        footer_parts.insert(1, f"Source: {he(source_label)}")
    footer_html = "  |  ".join(footer_parts)

    # ── generated date ────────────────────────────────────────────────────────
    gen_date = datetime.now().strftime("%d %b %Y, %I:%M %p")

    # ── org header ────────────────────────────────────────────────────────────
    logo_img_header = f'<img src="{logo_src}" alt="Logo" class="school-logo" onerror="this.style.visibility=\'hidden\'">' if logo_src else ""
    logo_img_watermark = f'<img src="{logo_src}" class="logo-watermark" alt="">' if logo_src else ""
    org_display = he(org_name) if org_name else "Querii"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{he(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {{
      --paper: #fff;
      --screen-bg: #e7ebf0;
      --navy: #0f172a;
      --gold: #b7791f;
      --text: #111827;
      --muted: #64748b;
      --border: #cbd5e1;
      --border-light: #e2e8f0;
    }}
    * {{ box-sizing: border-box; }}
    html {{ scroll-behavior: smooth; }}
    body {{
      margin: 0;
      background: var(--screen-bg);
      color: var(--text);
      font-family: "Plus Jakarta Sans", "Segoe UI", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }}
    .page {{
      position: relative;
      width: 210mm;
      min-height: 297mm;
      margin: 28px auto;
      padding: 12mm 14mm;
      background: var(--paper);
      box-shadow: 0 24px 60px rgba(15,23,42,.12), 0 4px 15px rgba(15,23,42,.05);
      overflow: hidden;
    }}
    /* Document border frame */
    .document-frame {{
      position: absolute; top:7mm; right:7mm; bottom:7mm; left:7mm;
      border: 1.2px solid #9ca8b7; pointer-events: none; z-index: 30;
    }}
    .document-frame::after {{
      content:""; position:absolute; top:2mm; right:2mm; bottom:2mm; left:2mm;
      border: .5px solid #e1e6eb;
    }}
    /* Watermark */
    .watermark-area {{
      position:absolute; top:7mm; right:7mm; bottom:7mm; left:7mm;
      overflow:hidden; pointer-events:none; z-index:0;
    }}
    .watermark-text {{
      position:absolute; left:-30%; top:-30%;
      display:flex; flex-direction:column;
      transform:rotate(-28deg); opacity:.060; z-index:1;
    }}
    .watermark-row {{
      display:flex; flex-shrink:0; align-items:center;
      height:26px; white-space:nowrap;
      font-family:"Plus Jakarta Sans",sans-serif;
      font-size:14px; font-weight:800; line-height:26px;
      letter-spacing:.55px; color:#475569;
    }}
    .logo-watermark-zone {{
      position:absolute; width:150mm; height:150mm;
      left:50%; top:52%; transform:translate(-50%,-50%);
      display:flex; align-items:center; justify-content:center;
      background:#fff; border-radius:50%; z-index:5;
    }}
    .logo-watermark {{ width:150mm; height:150mm; object-fit:contain; opacity:.045; filter:grayscale(100%); }}
    /* Keep content above watermark */
    .page > *:not(.watermark-area):not(.document-frame) {{ position:relative; z-index:10; }}
    /* School Header */
    .school-header {{
      display:flex; align-items:center; justify-content:center; gap:23px;
      min-height:108px; padding:17px 24px;
      background:#f8fafc; border:1px solid var(--border);
      border-radius:13px; margin-bottom:21px; text-align:center;
    }}
    .school-logo {{ width:78px; height:78px; object-fit:contain; flex-shrink:0; border-radius:50%; }}
    .school-info {{ display:flex; flex-direction:column; align-items:center; }}
    .school-info h2 {{
      margin:0 0 6px;
      font-family:"Playfair Display",Georgia,serif;
      font-size:24px; line-height:1.18; font-weight:800; color:var(--navy);
    }}
    .address {{ font-size:12px; line-height:1.35; color:var(--muted); font-weight:600; }}
    .school-meta {{
      display:flex; justify-content:center; flex-wrap:wrap;
      gap:22px; margin-top:7px;
      font-size:11px; font-weight:800; color:var(--navy);
    }}
    /* Document Heading */
    .document-heading {{
      display:flex; flex-direction:column; align-items:center;
      padding:3px 0 14px; margin-bottom:23px;
      text-align:center; border-bottom:2px solid var(--navy);
    }}
    .heading-accent {{ width:52px; height:3px; margin-bottom:8px; background:var(--gold); border-radius:4px; }}
    .title {{
      margin:0; width:100%;
      font-family:"Playfair Display",Georgia,serif;
      font-size:29px; line-height:1.2; font-weight:800; color:var(--navy);
    }}
    .gen-date {{ font-size:11px; color:var(--muted); margin-top:4px; }}
    /* Data Table — Apple-style rounded corners */
    .data-table-wrap {{
      width:100%; overflow:auto; margin-bottom:14px;
    }}
    .data-table {{
      width:100%; border-collapse:separate; border-spacing:0;
      font-size:10px; border-radius:12px; overflow:hidden;
      border:1px solid var(--border);
    }}
    .data-table thead tr th {{
      background:var(--navy); color:#fff;
      padding:8px 10px; font-weight:700;
      font-size:10px; text-align:left;
      border-bottom:2px solid var(--gold);
    }}
    .data-table thead tr th:first-child {{ border-top-left-radius:11px; }}
    .data-table thead tr th:last-child  {{ border-top-right-radius:11px; }}
    .data-table tbody tr td {{
      padding:6px 10px;
      border-bottom:1px solid var(--border-light);
      vertical-align:middle; word-break:break-word;
      max-width:200px;
    }}
    .data-table tbody tr:nth-child(even) {{ background:#f8fafc; }}
    .data-table tbody tr:hover {{ background:#f1f5f9; }}
    .data-table tbody tr:last-child td {{ border-bottom:none; }}
    .data-table tbody tr:last-child td:first-child {{ border-bottom-left-radius:11px; }}
    .data-table tbody tr:last-child td:last-child  {{ border-bottom-right-radius:11px; }}
    /* Footer */
    .report-footer {{
      text-align:center; font-size:10px; color:var(--muted);
      margin-top:8px; padding-top:8px; border-top:1px solid var(--border-light);
    }}
    /* SQL block */
    .sql-block {{ margin-top:14px; }}
    .sql-label {{ font-size:9px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; margin-bottom:4px; }}
    .sql-pre {{
      background:#f8fafc; border:1px solid var(--border); border-radius:6px;
      padding:8px 10px; font-size:8px; font-family:monospace;
      white-space:pre-wrap; word-break:break-all; color:#334155;
    }}
    /* Print */
    @page {{ size: {css_page_size}; margin: 0; }}
    @media print {{
      html, body {{ width:210mm; margin:0; padding:0; background:#fff !important; }}
      .page {{ width:210mm; margin:0; padding:12mm 14mm; box-shadow:none; }}
      .watermark-text {{ opacity:.060; }}
      .logo-watermark {{ opacity:.045; }}
      .school-header, .document-heading {{ break-inside:avoid; }}
      .data-table {{ page-break-inside:auto; }}
      .data-table tr {{ page-break-inside:avoid; page-break-after:auto; }}
    }}
    /* ── CUSTOM CSS (user-injected) ── */
{custom_css}
  </style>
</head>
<body>
  <main class="page">
    <div class="document-frame" aria-hidden="true"></div>
    <!-- Watermark -->
    <div class="watermark-area" id="watermarkArea" aria-hidden="true">
      <div class="watermark-text" id="watermarkText"></div>
      <div class="logo-watermark-zone">
        {logo_img_watermark}
      </div>
    </div>
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
        <tbody>{tbody_rows}</tbody>
      </table>
    </div>
    <!-- Footer -->
    <div class="report-footer">{footer_html}</div>
    {sql_block}
  </main>
  <script>
    // Watermark generation
    (function() {{
      var area = document.getElementById('watermarkArea');
      var text = document.getElementById('watermarkText');
      if (!area || !text) return;
      var w = area.clientWidth * 1.6, h = area.clientHeight * 1.6;
      text.style.width = w + 'px'; text.style.height = h + 'px';
      var wt = '{wm_text}';
      var probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-family:"Plus Jakarta Sans",sans-serif;font-size:14px;font-weight:800;letter-spacing:.55px;';
      probe.textContent = wt; document.body.appendChild(probe);
      var tw = probe.getBoundingClientRect().width; probe.remove();
      var rows = Math.ceil(h / 26) + 5, cols = Math.ceil(w / (tw || 200)) + 5;
      for (var r = 0; r < rows; r++) {{
        var row = document.createElement('div'); row.className = 'watermark-row';
        if (r % 2) row.style.transform = 'translateX(-35px)';
        for (var c = 0; c < cols; c++) {{
          var sp = document.createElement('span'); sp.textContent = wt; row.appendChild(sp);
        }}
        text.appendChild(row);
      }}
    }})();
    // Auto print-to-PDF and close when triggered by Chromium headless
    if (window._QUERII_PRINT) {{ window.print(); }}
  </script>
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
    Render query results to PDF using headless Chromium.
    Falls back to export_pdf() if no Chromium is found.
    """
    chromium = _find_chromium()
    if not chromium:
        # Graceful fallback to ReportLab
        export_pdf(
            columns=columns, rows=rows, filepath=filepath,
            title=title, org_name=org_name, logo_b64=logo_b64,
            sql_display=sql_display, source_label=source_label,
            page_size=page_size, orientation=orientation,
        )
        return

    html_content = _build_pdf_html(
        columns=columns, rows=rows, title=title, org_name=org_name,
        logo_b64=logo_b64, sql_display=sql_display, source_label=source_label,
        custom_css=custom_css, page_size=page_size, orientation=orientation,
    )

    out_path = str(Path(filepath))

    # Write HTML to a temp file
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".html", encoding="utf-8", delete=False
    ) as tmp:
        tmp.write(html_content)
        tmp_html = tmp.name

    try:
        # Page size for Chromium (mm)
        size_map = {"A4": "--print-media-type", "A3": "--print-media-type", "Letter": "--print-media-type"}
        paper_flag = [
            "--print-to-pdf-no-header",
        ]
        if page_size == "A3":
            paper_flag += ["--printer-paper-size={width=297,height=420,unit=mm}"]
        elif page_size == "Letter":
            paper_flag += ["--printer-paper-size={width=216,height=279,unit=mm}"]
        # else default A4

        cmd = [
            chromium,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            f"--print-to-pdf={out_path}",
            "--print-to-pdf-no-header",
            f"file://{tmp_html}",
        ]
        result = subprocess.run(
            cmd,
            timeout=60,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Chromium exit {result.returncode}: {result.stderr[:400]}")
    except Exception as e:
        # Fallback to ReportLab
        print(f"[PDF HTML export] Chromium failed: {e}. Falling back to ReportLab.")
        export_pdf(
            columns=columns, rows=rows, filepath=filepath,
            title=title, org_name=org_name, logo_b64=logo_b64,
            sql_display=sql_display, source_label=source_label,
            page_size=page_size, orientation=orientation,
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
