"""Render PacketBench's Workspace/Agents/Settings decision Markdown as a PDF."""

from __future__ import annotations

import argparse
import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    KeepTogether,
    LongTable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


INK = colors.HexColor("#17202A")
MUTED = colors.HexColor("#5D6D7E")
GREEN = colors.HexColor("#00C878")
GREEN_DARK = colors.HexColor("#087A50")
NAVY = colors.HexColor("#10202D")
PANEL = colors.HexColor("#F2F6F5")
LINE = colors.HexColor("#D5DFDC")
AMBER = colors.HexColor("#B86A00")
WHITE = colors.white


def register_fonts() -> tuple[str, str, str]:
    candidates = [
        (
            Path("C:/Windows/Fonts/segoeui.ttf"),
            Path("C:/Windows/Fonts/seguisb.ttf"),
            Path("C:/Windows/Fonts/consola.ttf"),
        ),
        (
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
        ),
    ]
    for regular, bold, mono in candidates:
        if regular.exists() and bold.exists() and mono.exists():
            pdfmetrics.registerFont(TTFont("PacketSans", str(regular)))
            pdfmetrics.registerFont(TTFont("PacketSansBold", str(bold)))
            pdfmetrics.registerFont(TTFont("PacketMono", str(mono)))
            return "PacketSans", "PacketSansBold", "PacketMono"
    return "Helvetica", "Helvetica-Bold", "Courier"


FONT, FONT_BOLD, FONT_MONO = register_fonts()


def inline_markup(value: str) -> str:
    """Convert the small Markdown inline subset used by the report."""
    rendered = html.escape(value.strip(), quote=True)
    rendered = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        lambda m: f'<link href="{m.group(2)}" color="#087A50"><u>{m.group(1)}</u></link>',
        rendered,
    )
    rendered = re.sub(
        r"`([^`]+)`",
        lambda m: f'<font name="{FONT_MONO}" color="#334E5C">{m.group(1)}</font>',
        rendered,
    )
    rendered = re.sub(r"\*\*([^*]+)\*\*", rf'<font name="{FONT_BOLD}">\1</font>', rendered)
    return rendered


def build_styles():
    base = getSampleStyleSheet()
    return {
        "body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=9.2,
            leading=13,
            textColor=INK,
            spaceAfter=6,
        ),
        "small": ParagraphStyle(
            "Small",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=7.5,
            leading=10,
            textColor=MUTED,
        ),
        "h2": ParagraphStyle(
            "H2",
            parent=base["Heading2"],
            fontName=FONT_BOLD,
            fontSize=17,
            leading=21,
            textColor=NAVY,
            spaceBefore=13,
            spaceAfter=7,
            keepWithNext=True,
        ),
        "h3": ParagraphStyle(
            "H3",
            parent=base["Heading3"],
            fontName=FONT_BOLD,
            fontSize=12,
            leading=15,
            textColor=GREEN_DARK,
            spaceBefore=9,
            spaceAfter=5,
            keepWithNext=True,
        ),
        "h4": ParagraphStyle(
            "H4",
            parent=base["Heading4"],
            fontName=FONT_BOLD,
            fontSize=10,
            leading=13,
            textColor=AMBER,
            spaceBefore=7,
            spaceAfter=4,
            keepWithNext=True,
        ),
        "bullet": ParagraphStyle(
            "Bullet",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=8.8,
            leading=12.2,
            leftIndent=13,
            firstLineIndent=-7,
            bulletIndent=4,
            textColor=INK,
            spaceAfter=3,
        ),
        "quote": ParagraphStyle(
            "Quote",
            parent=base["BodyText"],
            fontName=FONT_BOLD,
            fontSize=10.5,
            leading=15,
            leftIndent=12,
            rightIndent=12,
            textColor=NAVY,
            backColor=colors.HexColor("#E8F8F1"),
            borderColor=GREEN,
            borderWidth=0.8,
            borderPadding=10,
            spaceBefore=7,
            spaceAfter=9,
        ),
        "table_header": ParagraphStyle(
            "TableHeader",
            parent=base["BodyText"],
            fontName=FONT_BOLD,
            fontSize=7.3,
            leading=9.5,
            textColor=WHITE,
        ),
        "table_cell": ParagraphStyle(
            "TableCell",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=7.2,
            leading=9.5,
            textColor=INK,
        ),
    }


STYLES = build_styles()


def table_widths(rows: list[list[str]], available: float) -> list[float]:
    count = max(len(row) for row in rows)
    max_lengths = []
    for index in range(count):
        max_lengths.append(
            max(
                5,
                min(55, max((len(row[index]) if index < len(row) else 0) for row in rows)),
            )
        )
    total = sum(max_lengths)
    widths = [available * length / total for length in max_lengths]
    floor = min(0.72 * inch, available / count)
    widths = [max(floor, width) for width in widths]
    scale = available / sum(widths)
    return [width * scale for width in widths]


def make_table(rows: list[list[str]], available: float):
    normalized = [row + [""] * (max(map(len, rows)) - len(row)) for row in rows]
    data = []
    for row_index, row in enumerate(normalized):
        style = STYLES["table_header"] if row_index == 0 else STYLES["table_cell"]
        data.append([Paragraph(inline_markup(cell), style) for cell in row])
    table = LongTable(
        data,
        colWidths=table_widths(normalized, available),
        repeatRows=1,
        hAlign="LEFT",
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
                ("BACKGROUND", (0, 1), (-1, -1), colors.white),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
                ("GRID", (0, 0), (-1, -1), 0.45, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return table


def is_table_separator(line: str) -> bool:
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def parse_markdown(text: str, available: float):
    lines = text.splitlines()
    story = []
    paragraph: list[str] = []
    major_count = 0
    index = 0

    def flush_paragraph():
        nonlocal paragraph
        if paragraph:
            story.append(Paragraph(inline_markup(" ".join(paragraph)), STYLES["body"]))
            paragraph = []

    while index < len(lines):
        line = lines[index].rstrip()
        stripped = line.strip()

        if index == 0 and stripped.startswith("# "):
            index += 1
            continue

        if not stripped:
            flush_paragraph()
            index += 1
            continue

        if stripped.startswith("Date:") or stripped.startswith("Status:") or stripped.startswith(
            "Scope:"
        ):
            index += 1
            continue

        if (
            stripped.startswith("|")
            and index + 1 < len(lines)
            and is_table_separator(lines[index + 1])
        ):
            flush_paragraph()
            raw_rows = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                raw_rows.append(
                    [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
                )
                index += 1
            rows = [raw_rows[0], *raw_rows[2:]]
            story.extend([make_table(rows, available), Spacer(1, 9)])
            continue

        if stripped.startswith("## "):
            flush_paragraph()
            major_count += 1
            if major_count > 1 and stripped == "## Primary sources":
                story.append(PageBreak())
            story.append(Paragraph(inline_markup(stripped[3:]), STYLES["h2"]))
            index += 1
            continue

        if stripped.startswith("### "):
            flush_paragraph()
            story.append(Paragraph(inline_markup(stripped[4:]), STYLES["h3"]))
            index += 1
            continue

        if stripped.startswith("#### "):
            flush_paragraph()
            story.append(Paragraph(inline_markup(stripped[5:]), STYLES["h4"]))
            index += 1
            continue

        if stripped.startswith("> "):
            flush_paragraph()
            quote_lines = []
            while index < len(lines) and lines[index].strip().startswith(">"):
                quote_lines.append(lines[index].strip().lstrip(">").strip())
                index += 1
            story.append(Paragraph(inline_markup(" ".join(quote_lines)), STYLES["quote"]))
            continue

        bullet_match = re.match(r"^[-*]\s+(.*)$", stripped)
        numbered_match = re.match(r"^(\d+)\.\s+(.*)$", stripped)
        if bullet_match or numbered_match:
            flush_paragraph()
            items = []
            ordered = numbered_match is not None
            while index < len(lines):
                current = lines[index].strip()
                match = re.match(r"^(\d+)\.\s+(.*)$", current) if ordered else re.match(
                    r"^[-*]\s+(.*)$", current
                )
                if not match:
                    break
                body = match.group(2) if ordered else match.group(1)
                marker = f"{match.group(1)}." if ordered else "-"
                index += 1
                continuation = []
                while index < len(lines):
                    following = lines[index].strip()
                    if not following:
                        break
                    next_item = (
                        re.match(r"^\d+\.\s+", following)
                        if ordered
                        else re.match(r"^[-*]\s+", following)
                    )
                    if next_item or following.startswith(("#", ">", "|")):
                        break
                    continuation.append(following)
                    index += 1
                if continuation:
                    body = " ".join([body, *continuation])
                items.append(
                    Paragraph(
                        f'<font name="{FONT_BOLD}">{marker}</font> {inline_markup(body)}',
                        STYLES["bullet"],
                    )
                )
            story.append(KeepTogether(items[:2]) if len(items) <= 2 else items[0])
            if len(items) > 2:
                story.extend(items[1:])
            continue

        paragraph.append(stripped)
        index += 1

    flush_paragraph()
    return story


def title_page():
    title = Paragraph(
        "PacketBench<br/>Workspace, Agents, and Settings",
        ParagraphStyle(
            "Title",
            fontName=FONT_BOLD,
            fontSize=30,
            leading=35,
            textColor=WHITE,
            alignment=TA_LEFT,
        ),
    )
    subtitle = Paragraph(
        "Decision report | 29 July 2026",
        ParagraphStyle(
            "Subtitle",
            fontName=FONT,
            fontSize=11,
            leading=15,
            textColor=colors.HexColor("#C9DDD5"),
        ),
    )
    banner = Table(
        [[title], [subtitle]],
        colWidths=[6.65 * inch],
        rowHeights=[1.86 * inch, 0.42 * inch],
    )
    banner.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), NAVY),
                ("BOX", (0, 0), (-1, -1), 0, NAVY),
                ("LEFTPADDING", (0, 0), (-1, -1), 24),
                ("RIGHTPADDING", (0, 0), (-1, -1), 24),
                ("TOPPADDING", (0, 0), (-1, 0), 24),
                ("BOTTOMPADDING", (0, 1), (-1, 1), 18),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    recommendation = Paragraph(
        '<font name="%s" size="13">RECOMMENDATION</font><br/><br/>'
        '<font name="%s" size="19">Make Workspaces CLI-first. Keep GUI agents, '
        "but give them an agent-first surface. Build that surface in the main "
        "window before making it detachable.</font>"
        % (FONT_BOLD, FONT_BOLD),
        ParagraphStyle(
            "Recommendation",
            fontName=FONT,
            fontSize=12,
            leading=24,
            textColor=NAVY,
            backColor=colors.HexColor("#E8F8F1"),
            borderColor=GREEN,
            borderWidth=1,
            borderPadding=18,
        ),
    )
    summary = Table(
        [
            [
                Paragraph("<b>Workspace</b><br/>PacketCode + CLI command center", STYLES["body"]),
                Paragraph("<b>Agents</b><br/>Delegation, approvals, and review", STYLES["body"]),
                Paragraph("<b>Flight Deck</b><br/>Structured delivery", STYLES["body"]),
            ]
        ],
        colWidths=[2.13 * inch] * 3,
    )
    summary.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PANEL),
                ("GRID", (0, 0), (-1, -1), 0.6, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 10),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
            ]
        )
    )
    note = Paragraph(
        "Prepared from a three-way source audit: PacketBench implementation, current "
        "first-party competitor documentation, and the complete Settings control/"
        "persistence/runtime path. Recommendations are separated from facts.",
        ParagraphStyle(
            "TitleNote",
            fontName=FONT,
            fontSize=9,
            leading=13,
            textColor=MUTED,
            alignment=TA_CENTER,
        ),
    )
    return [
        Spacer(1, 0.45 * inch),
        banner,
        Spacer(1, 0.55 * inch),
        recommendation,
        Spacer(1, 0.38 * inch),
        summary,
        Spacer(1, 0.48 * inch),
        note,
        PageBreak(),
    ]


def page_header_footer(canvas, doc):
    canvas.saveState()
    width, height = letter
    if doc.page > 1:
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.5)
        canvas.line(doc.leftMargin, height - 0.52 * inch, width - doc.rightMargin, height - 0.52 * inch)
        canvas.setFont(FONT_BOLD, 7.5)
        canvas.setFillColor(GREEN_DARK)
        canvas.drawString(doc.leftMargin, height - 0.39 * inch, "PACKETBENCH DECISION REPORT")
        canvas.setFont(FONT, 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawRightString(
            width - doc.rightMargin,
            height - 0.39 * inch,
            "Workspace | Agents | Settings",
        )
    canvas.setStrokeColor(LINE)
    canvas.line(doc.leftMargin, 0.48 * inch, width - doc.rightMargin, 0.48 * inch)
    canvas.setFont(FONT, 7.3)
    canvas.setFillColor(MUTED)
    canvas.drawString(doc.leftMargin, 0.30 * inch, "Decision evidence - 2026-07-29")
    canvas.drawRightString(width - doc.rightMargin, 0.30 * inch, f"{doc.page}")
    canvas.restoreState()


def render(source: Path, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    text = source.read_text(encoding="utf-8")
    doc = SimpleDocTemplate(
        str(destination),
        pagesize=letter,
        rightMargin=0.64 * inch,
        leftMargin=0.64 * inch,
        topMargin=0.70 * inch,
        bottomMargin=0.64 * inch,
        title="PacketBench Workspace, Agents, and Settings Decision Report",
        author="PacketBench",
        subject="Product-surface and Settings audit",
    )
    available = letter[0] - doc.leftMargin - doc.rightMargin
    story = title_page()
    story.extend(parse_markdown(text, available))
    doc.build(story, onFirstPage=page_header_footer, onLaterPages=page_header_footer)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    render(args.source.resolve(), args.destination.resolve())


if __name__ == "__main__":
    main()
