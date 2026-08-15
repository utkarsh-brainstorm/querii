"""
core/exporter.py
================
Export query results to CSV and PDF.
"""

from __future__ import annotations

import csv
import os
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
    theme_colors: Optional[dict] = None,
    page_size: str = "A4",
    orientation: str = "portrait",
    scale: float = 1.0,
    continuous: bool = False,
    source_label: str = "",
) -> None:
    """Render a table to PDF using ReportLab with dynamic theming.

    Continuous mode
    ---------------
    When *continuous* is True the output is a single, unbroken page whose
    height is computed from the actual row count.  ReportLab's ``Table``
    does NOT accept a ``splitByRow`` keyword argument, so that parameter
    has been removed entirely.  The old approach of setting
    ``splitByRow=0`` caused a silent ``TypeError`` that swallowed the
    entire export.  Instead we pre-calculate the required canvas height
    and set it as the page size so ReportLab never needs to split the
    table across pages.

    Normal mode
    -----------
    Uses A4 / A3 / Letter with portrait or landscape orientation exactly
    as before.

    Windows-safe paths
    ------------------
    ``filepath`` is always resolved through :class:`pathlib.Path` so
    that no manual string concatenation with ``/`` is needed.
    """
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, A3, letter
        from reportlab.lib.pagesizes import landscape as rl_landscape
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate,
            Table,
            TableStyle,
            Paragraph,
            Spacer,
            HRFlowable,
        )
        from reportlab.lib.enums import TA_CENTER
        import base64
        import tempfile
    except ImportError:
        raise ImportError(
            "reportlab is required for PDF export. "
            "Install it with: pip install reportlab"
        )

    # ── Cross-platform safe output path ──────────────────────────────────────
    out_path = str(Path(filepath))

    # ── Theme colours ─────────────────────────────────────────────────────────
    tc = theme_colors or {}
    c_bg     = colors.HexColor(tc.get("bg",     "#ffffff"))
    c_text   = colors.HexColor(tc.get("text",   "#1d1d1f"))
    c_head   = colors.HexColor(tc.get("head",   "#1d1d1f"))
    c_border = colors.HexColor(tc.get("border", "#d2d2d7"))

    # ── Scale factor ─────────────────────────────────────────────────────────
    scale = max(0.4, min(2.0, float(scale or 1.0)))

    # ── Margins ──────────────────────────────────────────────────────────────
    has_logo   = bool(logo_b64)
    top_margin = int((22 if has_logo else 14) * mm * scale)
    h_margin   = int(12 * mm * scale)
    b_margin   = int(14 * mm * scale)

    # ── Page size resolution ──────────────────────────────────────────────────
    PAGE_SIZES = {"A4": A4, "A3": A3, "Letter": letter}
    base_pagesize = PAGE_SIZES.get(page_size, A4)
    if orientation == "landscape":
        base_pagesize = rl_landscape(base_pagesize)

    if continuous:
        # Compute a page tall enough to hold every row without any page break.
        #
        # Breakdown of the estimated height:
        #   header_block  – logo height + title + generated-date + spacers
        #                   + HR + spacer ≈ 40 mm (generous)
        #   table_rows    – one header row + len(rows) data rows
        #   footer_block  – record count paragraph + optional SQL block ≈ 20 mm
        #   buffer        – 20 mm safety margin
        #
        # Row-height estimate uses the same padding values applied later so
        # that cell wrapping on short values still fits within the page.
        est_row_h    = int(6 * mm * scale)          # typical single-line row
        header_block = int(40 * mm * scale)          # logo + title area
        footer_block = int(20 * mm * scale)
        buffer       = int(20 * mm)

        # +1 for the table header row itself
        table_height = (len(rows) + 1) * est_row_h

        est_height = (
            top_margin
            + header_block
            + table_height
            + footer_block
            + b_margin
            + buffer
        )

        # Never narrower/shorter than a standard A4
        page_w  = base_pagesize[0]
        page_h  = max(297 * mm, est_height)
        pagesize = (page_w, page_h)
    else:
        pagesize = base_pagesize

    # ── Custom DocTemplate: fills background colour ───────────────────────────
    class ThemeDocTemplate(SimpleDocTemplate):
        def beforePage(self) -> None:
            self.canv.saveState()
            self.canv.setFillColor(c_bg)
            self.canv.rect(
                0, 0, self.pagesize[0], self.pagesize[1], fill=1, stroke=0
            )
            self.canv.restoreState()

    doc = ThemeDocTemplate(
        out_path,
        pagesize=pagesize,
        rightMargin=h_margin,
        leftMargin=h_margin,
        topMargin=top_margin,
        bottomMargin=b_margin,
    )

    # ── Paragraph styles ─────────────────────────────────────────────────────
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

    story: list = []

    # ── Org logo (if provided) ────────────────────────────────────────────────
    _logo_tmp = None
    if logo_b64:
        try:
            from reportlab.platypus import Image as RLImage
            from reportlab.lib.utils import ImageReader

            logo_bytes = base64.b64decode(logo_b64)
            _logo_tmp  = tempfile.NamedTemporaryFile(
                delete=False, suffix=".png"
            )
            _logo_tmp.write(logo_bytes)
            _logo_tmp.flush()
            _logo_tmp.close()

            img_reader = ImageReader(_logo_tmp.name)
            img_w, img_h = img_reader.getSize()
            aspect   = img_w / float(img_h)
            target_h = int(22 * mm * scale)
            target_w = target_h * aspect
            page_w   = pagesize[0] - 2 * h_margin
            if target_w > page_w:
                target_w = page_w
                target_h = int(target_w / aspect)

            img = RLImage(_logo_tmp.name, width=target_w, height=target_h)
            img.hAlign = "CENTER"
            story.append(img)
            story.append(Spacer(1, int(2 * mm)))
        except Exception:
            pass

    # ── Title block ───────────────────────────────────────────────────────────
    story.append(Paragraph(title, title_style))
    story.append(
        Paragraph(
            f"Generated: {datetime.now().strftime('%d %b %Y, %I:%M %p')}",
            sub_style,
        )
    )
    story.append(Spacer(1, int(3 * mm)))
    story.append(HRFlowable(width="100%", thickness=1, color=c_border))
    story.append(Spacer(1, int(3 * mm)))

    if not rows:
        story.append(Paragraph("No records found.", styles["Normal"]))
        doc.build(story)
        return

    # ── Build table ───────────────────────────────────────────────────────────
    header_row = [
        Paragraph(f"<b>{col}</b>", header_cell_style) for col in columns
    ]
    data = [header_row]
    for row in rows:
        data.append(
            [
                Paragraph(str(row.get(col, "") or ""), cell_style)
                for col in columns
            ]
        )

    # Distribute available width evenly across columns
    avail_w    = pagesize[0] - 2 * h_margin
    col_w      = avail_w / max(len(columns), 1)
    col_widths = [col_w] * len(columns)

    # NOTE: ``splitByRow`` is NOT a valid Table kwarg in ReportLab.
    # For continuous mode the page height is pre-calculated to be large
    # enough that no split is ever triggered, so no extra kwarg is needed.
    table = Table(
        data,
        colWidths=col_widths,
        repeatRows=1,
    )

    pad = int(4 * scale)
    table.setStyle(
        TableStyle(
            [
                # Header row
                ("BACKGROUND",    (0, 0), (-1, 0),  c_head),
                ("TEXTCOLOR",     (0, 0), (-1, 0),  c_bg),
                ("FONTNAME",      (0, 0), (-1, 0),  "Helvetica-Bold"),
                ("FONTSIZE",      (0, 0), (-1, 0),  int(7 * scale)),
                ("BOTTOMPADDING", (0, 0), (-1, 0),  pad),
                ("TOPPADDING",    (0, 0), (-1, 0),  pad),
                # Body rows
                ("FONTNAME",      (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE",      (0, 1), (-1, -1), int(6 * scale)),
                ("BOTTOMPADDING", (0, 1), (-1, -1), pad - 1),
                ("TOPPADDING",    (0, 1), (-1, -1), pad - 1),
                ("LEFTPADDING",   (0, 0), (-1, -1), pad),
                ("RIGHTPADDING",  (0, 0), (-1, -1), pad),
                # Grid
                ("GRID",          (0, 0), (-1, -1), 0.25, c_border),
                ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )

    story.append(table)
    story.append(Spacer(1, int(4 * mm)))

    # ── Footer: record count + attribution ────────────────────────────────────
    footer_parts = [f"Total Records: {len(rows)}", "Querii"]
    if source_label:
        footer_parts.insert(1, f"Source: {source_label}")
    story.append(Paragraph("  |  ".join(footer_parts), sub_style))

    # ── Optional SQL block at bottom ──────────────────────────────────────────
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
        story.append(
            HRFlowable(
                width="100%",
                thickness=0.5,
                color=colors.HexColor("#d2d2d7"),
            )
        )
        story.append(Spacer(1, int(2 * mm)))
        story.append(Paragraph("Query:", sql_label_style))
        for line in sql_display.split("\n")[:30]:
            if line.strip():
                story.append(
                    Paragraph(line.replace(" ", "&nbsp;"), sql_style)
                )

    # ── Render ────────────────────────────────────────────────────────────────
    doc.build(story)

    # ── Cleanup temporary logo file ───────────────────────────────────────────
    if _logo_tmp is not None:
        try:
            os.unlink(_logo_tmp.name)
        except Exception:
            pass
