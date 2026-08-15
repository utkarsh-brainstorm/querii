"""
core/exporter.py
================
Export query results to CSV and PDF.
"""

from __future__ import annotations

import csv
import os
from datetime import datetime
from typing import Dict, List


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------

def export_csv(columns: List[str], rows: List[Dict], filepath: str) -> None:
    """Write columns + rows to a CSV file."""
    with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({col: row.get(col, "") for col in columns})


# ---------------------------------------------------------------------------
# PDF (ReportLab)
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
    theme_colors: dict = None,
    page_size: str = "A4",
    orientation: str = "portrait",
    scale: float = 1.0,
    continuous: bool = False,
    source_label: str = "",
) -> None:
    """Render a table to PDF using ReportLab with dynamic theming."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, A3, letter, landscape as rl_landscape
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable,
        )
        from reportlab.lib.enums import TA_CENTER
        import base64
        import tempfile
    except ImportError:
        raise ImportError("reportlab is required for PDF export. Install it with: pip install reportlab")

    tc = theme_colors or {}
    c_bg     = colors.HexColor(tc.get("bg",     "#ffffff"))
    c_text   = colors.HexColor(tc.get("text",   "#1d1d1f"))
    c_head   = colors.HexColor(tc.get("head",   "#1d1d1f"))
    c_border = colors.HexColor(tc.get("border", "#d2d2d7"))

    # ── Page size resolution ──
    PAGE_SIZES = {"A4": A4, "A3": A3, "Letter": letter}
    base_pagesize = PAGE_SIZES.get(page_size, A4)
    if orientation == "landscape":
        base_pagesize = rl_landscape(base_pagesize)

    # Scale factor: shrinks/grows font sizes and margins
    scale = max(0.4, min(2.0, float(scale or 1.0)))

    top_margin = int(14 * mm * scale) if not logo_b64 else int(22 * mm * scale)
    h_margin   = int(12 * mm * scale)
    b_margin   = int(14 * mm * scale)

    # ── For continuous mode, use a very tall custom "page" so content never breaks ──
    if continuous:
        # Estimate required height: header + rows * row_height + footer
        est_row_h = 6 * mm * scale
        est_height = top_margin + b_margin + 30 * mm + len(rows) * est_row_h + 40 * mm
        # Minimum 297mm (A4 height), no upper bound
        w = base_pagesize[0]
        h = max(297 * mm, est_height)
        pagesize = (w, h)
    else:
        pagesize = base_pagesize

    # Custom DocTemplate to draw background
    class ThemeDocTemplate(SimpleDocTemplate):
        def beforePage(self):
            self.canv.saveState()
            self.canv.setFillColor(c_bg)
            self.canv.rect(0, 0, self.pagesize[0], self.pagesize[1], fill=1, stroke=0)
            self.canv.restoreState()

    doc = ThemeDocTemplate(
        filepath,
        pagesize=pagesize,
        rightMargin=h_margin,
        leftMargin=h_margin,
        topMargin=top_margin,
        bottomMargin=b_margin,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "QTitle",
        parent=styles["Normal"],
        fontSize=int(13 * scale),
        fontName="Helvetica-Bold",
        textColor=c_head,
        spaceAfter=3,
        alignment=TA_CENTER,
    )
    sub_style = ParagraphStyle(
        "QSub",
        parent=styles["Normal"],
        fontSize=int(8 * scale),
        fontName="Helvetica",
        textColor=c_text,
        spaceAfter=2,
        alignment=TA_CENTER,
    )
    cell_style = ParagraphStyle(
        "QCell",
        parent=styles["Normal"],
        fontSize=int(7 * scale),
        fontName="Helvetica",
        textColor=c_text,
        wordWrap="CJK",
    )
    header_cell_style = ParagraphStyle(
        "QHeaderCell",
        parent=styles["Normal"],
        fontSize=int(7 * scale),
        fontName="Helvetica-Bold",
        textColor=c_bg,
        wordWrap="CJK",
    )

    story = []

    # ── Org logo (if provided) ──
    _logo_tmp = None
    if logo_b64:
        try:
            from reportlab.platypus import Image as RLImage
            from reportlab.lib.utils import ImageReader
            logo_bytes = base64.b64decode(logo_b64)
            _logo_tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
            _logo_tmp.write(logo_bytes)
            _logo_tmp.flush()
            _logo_tmp.close()
            img_reader = ImageReader(_logo_tmp.name)
            img_w, img_h = img_reader.getSize()
            aspect = img_w / float(img_h)
            target_h = int(22 * mm * scale)
            target_w = target_h * aspect
            page_w = pagesize[0] - 2 * h_margin
            if target_w > page_w:
                target_w = page_w
                target_h = int(target_w / aspect)
            img = RLImage(_logo_tmp.name, width=target_w, height=target_h)
            img.hAlign = "CENTER"
            story.append(img)
            story.append(Spacer(1, int(2 * mm)))
        except Exception:
            pass

    # ── Title only (no filename header) ──
    story.append(Paragraph(title, title_style))
    story.append(Paragraph(
        f"Generated: {datetime.now().strftime('%d %b %Y, %I:%M %p')}",
        sub_style,
    ))
    story.append(Spacer(1, int(3 * mm)))
    story.append(HRFlowable(width="100%", thickness=1, color=c_border))
    story.append(Spacer(1, int(3 * mm)))

    if not rows:
        story.append(Paragraph("No records found.", styles["Normal"]))
        doc.build(story)
        return

    # ── Build table ──
    header_row = [Paragraph(f"<b>{col}</b>", header_cell_style) for col in columns]
    data = [header_row]
    for row in rows:
        data.append([
            Paragraph(str(row.get(col, "") or ""), cell_style)
            for col in columns
        ])

    # Distribute available width evenly
    avail_w = pagesize[0] - 2 * h_margin
    col_w   = avail_w / max(len(columns), 1)
    col_widths = [col_w] * len(columns)

    tbl_kwargs = {"colWidths": col_widths, "repeatRows": 1}
    if continuous:
        # No splitting: render entire table as one block
        tbl_kwargs["splitByRow"] = 0

    table = Table(data, **tbl_kwargs)
    pad   = int(4 * scale)
    table.setStyle(TableStyle([
        # Header
        ("BACKGROUND",    (0, 0), (-1, 0),  c_head),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  c_bg),
        ("FONTNAME",      (0, 0), (-1, 0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0), (-1, 0),  int(7 * scale)),
        ("BOTTOMPADDING", (0, 0), (-1, 0),  pad),
        ("TOPPADDING",    (0, 0), (-1, 0),  pad),
        # Body
        ("FONTNAME",      (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE",      (0, 1), (-1, -1), int(6 * scale)),
        ("BOTTOMPADDING", (0, 1), (-1, -1), pad - 1),
        ("TOPPADDING",    (0, 1), (-1, -1), pad - 1),
        ("LEFTPADDING",   (0, 0), (-1, -1), pad),
        ("RIGHTPADDING",  (0, 0), (-1, -1), pad),
        # Grid
        ("GRID",          (0, 0), (-1, -1), 0.25, c_border),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
    ]))

    story.append(table)
    story.append(Spacer(1, int(4 * mm)))

    # ── Footer: record count + source label ──
    footer_parts = [f"Total Records: {len(rows)}", "Querii"]
    if source_label:
        footer_parts.insert(1, f"Source: {source_label}")
    story.append(Paragraph("  |  ".join(footer_parts), sub_style))

    # ── SQL query at bottom (if provided) ──
    if sql_display:
        sql_style = ParagraphStyle(
            "QSqlBlock",
            parent=styles["Normal"],
            fontSize=int(6 * scale),
            fontName="Courier",
            textColor=colors.HexColor("#555555"),
            spaceAfter=2,
            leftIndent=4,
            leading=int(8 * scale),
        )
        sql_label_style = ParagraphStyle(
            "QSqlLabel",
            parent=styles["Normal"],
            fontSize=int(6 * scale),
            fontName="Courier-Bold",
            textColor=colors.HexColor("#333333"),
            spaceAfter=1,
        )
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#d2d2d7")))
        story.append(Spacer(1, int(2 * mm)))
        story.append(Paragraph("Query:", sql_label_style))
        for line in sql_display.split("\n")[:30]:
            if line.strip():
                story.append(Paragraph(line.replace(" ", "&nbsp;"), sql_style))

    doc.build(story)

    # Cleanup temp logo file
    if _logo_tmp is not None:
        try:
            os.unlink(_logo_tmp.name)
        except Exception:
            pass
