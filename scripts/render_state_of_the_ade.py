"""Render the State of the ADE Markdown report as the human-readable PDF.

The Markdown at docs/reports/state-of-the-ade-2026-07-30.md is the source of
truth (agent-facing edition). This script renders the same content as the
paginated human edition:

    python3 scripts/render_state_of_the_ade.py \
        docs/reports/state-of-the-ade-2026-07-30.md \
        docs/reports/state-of-the-ade-2026-07-30.pdf

Only the five screenshots named in EMBEDDED_SHOTS are embedded; the remaining
figures are rendered as captioned relative-path references so the PDF stays a
readable document rather than a contact sheet.
"""

from __future__ import annotations

import argparse
import html
import re
from pathlib import Path

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image,
    KeepTogether,
    LongTable,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents

INK = colors.HexColor("#17202A")
MUTED = colors.HexColor("#5D6D7E")
GREEN = colors.HexColor("#00C878")
GREEN_DARK = colors.HexColor("#087A50")
NAVY = colors.HexColor("#10202D")
PANEL = colors.HexColor("#F2F6F5")
LINE = colors.HexColor("#D5DFDC")
AMBER = colors.HexColor("#B86A00")
RED = colors.HexColor("#B3253C")
WHITE = colors.white

EMBEDDED_SHOTS = {
    "05-issues-board-1920.png",
    "07-history-1920.png",
    "09-settings-general-1280.png",
    "01-welcome-1920.png",
    "13-modal-new-flight-1280.png",
}

TITLE = "PacketADE \u2014 State of the ADE \u2014 2026-07"


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

SEVERITY_COLORS = {
    "Critical": "#B3253C",
    "High": "#B86A00",
    "Medium": "#8A6D1F",
    "Low": "#5D6D7E",
    "Polish": "#5D6D7E",
    "Resolved": "#087A50",
    "Fixed": "#087A50",
    "Partly resolved": "#B86A00",
    "OPEN": "#B3253C",
}


def inline_markup(value: str) -> str:
    """Convert the Markdown inline subset the report uses into RML markup."""
    rendered = html.escape(value.strip(), quote=False)
    rendered = re.sub(
        r"\[([^\]\[]+)\]\((https?://[^)]+)\)",
        lambda m: f'<link href="{m.group(2)}" color="#087A50"><u>{m.group(1)}</u></link>',
        rendered,
    )
    rendered = re.sub(r"\[([^\]\[]+)\]\((?!https?://)[^)]*\)", r"\1", rendered)
    rendered = re.sub(
        r"`([^`]+)`",
        lambda m: f'<font name="{FONT_MONO}" color="#334E5C">{m.group(1)}</font>',
        rendered,
    )
    rendered = re.sub(r"\*\*([^*]+)\*\*", rf'<font name="{FONT_BOLD}">\1</font>', rendered)
    rendered = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<i>\1</i>", rendered)
    rendered = re.sub(r"~~([^~]+)~~", r"<strike>\1</strike>", rendered)

    def badge(match: re.Match) -> str:
        label = match.group(1)
        color = SEVERITY_COLORS.get(label)
        if not color:
            return match.group(0)
        return f'<font name="{FONT_BOLD}" color="{color}">{label.upper()}</font>'

    rendered = re.sub(r"\[([A-Za-z][A-Za-z ]{1,18})\]", badge, rendered)
    return rendered


def build_styles():
    base = getSampleStyleSheet()
    return {
        "body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=9.0,
            leading=12.6,
            textColor=INK,
            spaceAfter=6,
        ),
        "h2": ParagraphStyle(
            "H2",
            parent=base["Heading2"],
            fontName=FONT_BOLD,
            fontSize=17,
            leading=21,
            textColor=NAVY,
            spaceBefore=14,
            spaceAfter=8,
            keepWithNext=True,
        ),
        "h3": ParagraphStyle(
            "H3",
            parent=base["Heading3"],
            fontName=FONT_BOLD,
            fontSize=12,
            leading=15,
            textColor=GREEN_DARK,
            spaceBefore=10,
            spaceAfter=5,
            keepWithNext=True,
        ),
        "h4": ParagraphStyle(
            "H4",
            parent=base["Heading4"],
            fontName=FONT_BOLD,
            fontSize=9.8,
            leading=13,
            textColor=AMBER,
            spaceBefore=8,
            spaceAfter=4,
            keepWithNext=True,
        ),
        "h5": ParagraphStyle(
            "H5",
            parent=base["Heading4"],
            fontName=FONT_BOLD,
            fontSize=9.0,
            leading=12,
            textColor=MUTED,
            spaceBefore=7,
            spaceAfter=3,
            keepWithNext=True,
        ),
        "bullet": ParagraphStyle(
            "Bullet",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=8.7,
            leading=12.0,
            leftIndent=13,
            firstLineIndent=-7,
            bulletIndent=4,
            textColor=INK,
            spaceAfter=3,
        ),
        "quote": ParagraphStyle(
            "Quote",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=8.7,
            leading=12.2,
            leftIndent=12,
            rightIndent=8,
            textColor=NAVY,
            spaceAfter=4,
        ),
        "caption": ParagraphStyle(
            "Caption",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=7.6,
            leading=10,
            textColor=MUTED,
            spaceAfter=8,
            alignment=TA_CENTER,
        ),
        "figref": ParagraphStyle(
            "FigRef",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=8.0,
            leading=11,
            textColor=MUTED,
            leftIndent=10,
            spaceAfter=5,
        ),
        "table_header": ParagraphStyle(
            "TableHeader",
            parent=base["BodyText"],
            fontName=FONT_BOLD,
            fontSize=7.0,
            leading=9.0,
            textColor=WHITE,
        ),
        "table_cell": ParagraphStyle(
            "TableCell",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=6.9,
            leading=8.9,
            textColor=INK,
        ),
        "toc1": ParagraphStyle(
            "TOC1",
            fontName=FONT_BOLD,
            fontSize=10,
            leading=16,
            textColor=NAVY,
            spaceBefore=5,
        ),
        "toc2": ParagraphStyle(
            "TOC2",
            fontName=FONT,
            fontSize=8.6,
            leading=13,
            textColor=MUTED,
            leftIndent=18,
        ),
    }


STYLES = build_styles()


# ---------------------------------------------------------------- markdown ---


def split_row(line: str) -> list[str]:
    inner = line.strip()
    if inner.startswith("|"):
        inner = inner[1:]
    if inner.endswith("|"):
        inner = inner[:-1]
    cells, buf, escaped = [], [], False
    for ch in inner:
        if escaped:
            buf.append(ch)
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == "|":
            cells.append("".join(buf).strip())
            buf = []
            continue
        buf.append(ch)
    cells.append("".join(buf).strip())
    return cells


def is_divider(line: str) -> bool:
    return bool(re.fullmatch(r"\|[\s:|-]+\|", line.strip()))


def table_widths(rows: list[list[str]], available: float) -> list[float]:
    count = max(len(row) for row in rows)
    weights = []
    for index in range(count):
        lengths = [len(row[index]) if index < len(row) else 0 for row in rows]
        # Total character mass drives width: it is what actually equalises row
        # height, which is what drives page count on a table-heavy report.
        weights.append(max(8.0, sum(lengths) ** 0.85))
    total = sum(weights)
    widths = [available * w / total for w in weights]

    # A column must be wide enough for its longest unbreakable token, otherwise
    # reportlab hyphen-less-wraps mid-word and the cell turns into confetti.
    floors = []
    for index in range(count):
        longest = 0.0
        for row in rows:
            cell = row[index] if index < len(row) else ""
            for token in re.split(r"[\s/]+", re.sub(r"[`*\[\]]", "", cell)):
                width = pdfmetrics.stringWidth(token, FONT, 6.9)
                if len(token) <= 14:
                    # Severity/status badges render bold and uppercased.
                    width = max(width, pdfmetrics.stringWidth(token.upper(), FONT_BOLD, 6.9))
                longest = max(longest, width)
        floors.append(min(1.35 * inch, max(0.42 * inch, longest + 9)))

    if sum(floors) < available:
        slack = available - sum(floors)
        widths = [
            floors[i] + slack * (widths[i] / sum(widths))
            for i in range(count)
        ]
    scale = available / sum(widths)
    return [w * scale for w in widths]


def make_table(rows: list[list[str]], available: float):
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    widths = table_widths(rows, available)
    data = [[Paragraph(inline_markup(c), STYLES["table_header"]) for c in rows[0]]]
    for row in rows[1:]:
        data.append([Paragraph(inline_markup(c), STYLES["table_cell"]) for c in row])
    table = LongTable(data, colWidths=widths, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PANEL]),
                ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
            ]
        )
    )
    return table


def make_quote(lines: list[str], available: float):
    inner = parse_blocks(lines, available - 0.28 * inch)
    if not inner:
        return []
    wrapper = Table([[inner]], colWidths=[available])
    wrapper.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EDF7F2")),
                ("LINEBEFORE", (0, 0), (0, -1), 2.2, GREEN),
                ("BOX", (0, 0), (-1, -1), 0.4, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    return [Spacer(1, 3), wrapper, Spacer(1, 7)]


def make_image(src: str, alt: str, base_dir: Path, available: float):
    name = Path(src).name
    if name not in EMBEDDED_SHOTS:
        return [
            Paragraph(
                inline_markup(f"*Figure (not embedded):* `{src}`"),
                STYLES["figref"],
            )
        ]
    path = (base_dir / src).resolve()
    if not path.exists():
        return [Paragraph(inline_markup(f"*Missing figure:* `{src}`"), STYLES["figref"])]
    with PILImage.open(path) as probe:
        w, h = probe.size
    max_w = min(available, 6.0 * inch)
    scale = max_w / w
    max_h = 3.7 * inch
    if h * scale > max_h:
        scale = max_h / h
    image = Image(str(path), width=w * scale, height=h * scale)
    image.hAlign = "CENTER"
    return [Spacer(1, 4), image, Spacer(1, 3)]


HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
BULLET_RE = re.compile(r"^(\s*)([-*])\s+(.*)$")
ORDERED_RE = re.compile(r"^(\s*)(\d+)\.\s+(.*)$")
IMAGE_RE = re.compile(r"^!\[([^\]]*)\]\(([^)]+)\)\s*$")


def parse_blocks(lines: list[str], available: float, base_dir: Path | None = None):
    base_dir = base_dir or Path(".")
    story = []
    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        line = raw.rstrip()
        if not line.strip():
            i += 1
            continue
        if line.strip().startswith("<!--"):
            while i < n and "-->" not in lines[i]:
                i += 1
            i += 1
            continue
        if line.strip() == "---":
            story.append(Spacer(1, 8))
            i += 1
            continue

        heading = HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            text = heading.group(2).strip()
            if level == 1:
                i += 1
                continue
            key = {2: "h2", 3: "h3", 4: "h4"}.get(level, "h5")
            para = Paragraph(inline_markup(text), STYLES[key])
            if level == 2:
                story.append(PageBreak())
                para.toc_level = 0
                para.toc_text = text
            elif level == 3:
                para.toc_level = 1
                para.toc_text = text
            story.append(para)
            i += 1
            continue

        image = IMAGE_RE.match(line.strip())
        if image:
            story.extend(make_image(image.group(2), image.group(1), base_dir, available))
            i += 1
            continue

        if line.lstrip().startswith(">"):
            block = []
            while i < n and (lines[i].lstrip().startswith(">") or not lines[i].strip()):
                if not lines[i].strip():
                    nxt = i + 1
                    if nxt < n and lines[nxt].lstrip().startswith(">"):
                        block.append("")
                        i += 1
                        continue
                    break
                stripped = lines[i].lstrip()[1:]
                block.append(stripped[1:] if stripped.startswith(" ") else stripped)
                i += 1
            story.extend(make_quote(block, available))
            continue

        if line.strip().startswith("|"):
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                if not is_divider(lines[i]):
                    rows.append(split_row(lines[i]))
                i += 1
            if rows:
                story.append(Spacer(1, 3))
                story.append(make_table(rows, available))
                story.append(Spacer(1, 7))
            continue

        bullet = BULLET_RE.match(line)
        ordered = ORDERED_RE.match(line)
        if bullet or ordered:
            match = bullet or ordered
            indent = len(match.group(1))
            text = match.group(3)
            marker = "\u2022" if bullet else f"{match.group(2)}."
            j = i + 1
            while j < n and lines[j].strip() and not BULLET_RE.match(lines[j].rstrip()) \
                    and not ORDERED_RE.match(lines[j].rstrip()) \
                    and not HEADING_RE.match(lines[j].rstrip()) \
                    and not lines[j].strip().startswith(("|", ">")):
                text += " " + lines[j].strip()
                j += 1
            style = ParagraphStyle(
                f"bullet{indent}",
                parent=STYLES["bullet"],
                leftIndent=13 + indent * 8,
                bulletIndent=4 + indent * 8,
            )
            story.append(Paragraph(inline_markup(text), style, bulletText=marker))
            i = j
            continue

        para_lines = [line.strip()]
        i += 1
        while i < n and lines[i].strip() and not HEADING_RE.match(lines[i].rstrip()) \
                and not lines[i].strip().startswith(("|", ">", "- ", "* ", "!")) \
                and not ORDERED_RE.match(lines[i].rstrip()):
            para_lines.append(lines[i].strip())
            i += 1
        story.append(Paragraph(inline_markup(" ".join(para_lines)), STYLES["body"]))
    return story


# ------------------------------------------------------------------- cover ---


def cover(meta: list[str]) -> list:
    title = Paragraph(
        '<font name="%s" size="30">State of the ADE</font><br/><br/>'
        '<font name="%s" size="14" color="#8FE9BE">Living product-state report for the '
        "PacketADE Agent Development Environment</font>" % (FONT_BOLD, FONT),
        ParagraphStyle("CoverTitle", fontName=FONT_BOLD, fontSize=30, leading=36, textColor=WHITE),
    )
    kicker = Paragraph(
        '<font name="%s" size="10" color="#00C878">PACKET ADE &nbsp;//&nbsp; FLAGSHIP DELIVERABLE</font>'
        % FONT_BOLD,
        ParagraphStyle("Kicker", fontName=FONT, fontSize=10, leading=14, textColor=GREEN),
    )
    banner = Table(
        [[kicker], [title]],
        colWidths=[6.72 * inch],
        rowHeights=[0.55 * inch, 2.15 * inch],
    )
    banner.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), NAVY),
                ("LEFTPADDING", (0, 0), (-1, -1), 26),
                ("RIGHTPADDING", (0, 0), (-1, -1), 26),
                ("TOPPADDING", (0, 0), (-1, 0), 26),
                ("BOTTOMPADDING", (0, 1), (-1, 1), 22),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    summary = Paragraph(
        '<font name="%s" size="12">The original seven-domain review plus the 2026-08-01 '
        "source, proof, Settings, Git-authority, and operational-truth status pass. Section 0 "
        "is current; the detailed July audit remains preserved as dated evidence.</font>" % FONT,
        ParagraphStyle(
            "CoverSummary",
            fontName=FONT,
            fontSize=12,
            leading=18,
            textColor=NAVY,
            backColor=colors.HexColor("#E8F8F1"),
            borderColor=GREEN,
            borderWidth=1,
            borderPadding=16,
        ),
    )
    meta_rows = [
        [
            Paragraph(f'<font name="{FONT_BOLD}">{k}</font><br/>{v}', STYLES["body"])
            for k, v in pair
        ]
        for pair in meta
    ]
    meta_table = Table(meta_rows, colWidths=[2.24 * inch] * 3)
    meta_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PANEL),
                ("GRID", (0, 0), (-1, -1), 0.6, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 9),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
            ]
        )
    )
    note = Paragraph(
        "The machine-readable edition of this document, with stable finding IDs and grep recipes, "
        "is docs/reports/state-of-the-ade-2026-07-30.md. Both editions carry identical content.",
        ParagraphStyle(
            "CoverNote",
            fontName=FONT,
            fontSize=8.6,
            leading=12,
            textColor=MUTED,
            alignment=TA_CENTER,
        ),
    )
    return [
        Spacer(1, 0.4 * inch),
        banner,
        Spacer(1, 0.5 * inch),
        summary,
        Spacer(1, 0.42 * inch),
        meta_table,
        Spacer(1, 0.4 * inch),
        note,
        PageBreak(),
    ]


class ReportDoc(BaseDocTemplate):
    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph) and hasattr(flowable, "toc_level"):
            self.notify(
                "TOCEntry", (flowable.toc_level, flowable.toc_text, self.page)
            )


def page_furniture(canvas, doc):
    canvas.saveState()
    width, height = letter
    if doc.page > 1:
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.5)
        canvas.line(doc.leftMargin, height - 0.52 * inch, width - doc.rightMargin, height - 0.52 * inch)
        canvas.setFont(FONT_BOLD, 7.3)
        canvas.setFillColor(GREEN_DARK)
        canvas.drawString(doc.leftMargin, height - 0.39 * inch, "PACKETADE \u2014 STATE OF THE ADE")
        canvas.setFont(FONT, 7.3)
        canvas.setFillColor(MUTED)
        canvas.drawRightString(
            width - doc.rightMargin, height - 0.39 * inch, "status 2026-08-01 \u00b7 package source fd8c226"
        )
    canvas.setStrokeColor(LINE)
    canvas.line(doc.leftMargin, 0.48 * inch, width - doc.rightMargin, 0.48 * inch)
    canvas.setFont(FONT, 7.2)
    canvas.setFillColor(MUTED)
    canvas.drawString(doc.leftMargin, 0.30 * inch, "Human edition \u2014 machine edition: state-of-the-ade-2026-07-30.md")
    canvas.drawRightString(width - doc.rightMargin, 0.30 * inch, str(doc.page))
    canvas.restoreState()


def render(source: Path, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    text = source.read_text(encoding="utf-8")
    lines = text.replace("\r\n", "\n").split("\n")

    doc = ReportDoc(
        str(destination),
        pagesize=letter,
        rightMargin=0.64 * inch,
        leftMargin=0.64 * inch,
        topMargin=0.70 * inch,
        bottomMargin=0.64 * inch,
        title=TITLE,
        author="PacketADE engineering review",
        subject="Living State of the ADE report, status pass 2026-08-01",
    )
    frame = Frame(
        doc.leftMargin,
        doc.bottomMargin,
        doc.width,
        doc.height,
        id="body",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=page_furniture)])

    meta = [
        [("Report", "2026-07-30 living record"), ("Status pass", "2026-08-01"), ("Package source", "fd8c226 on pushed main")],
        [("Version", "0.10.2 \u00b7 protocol v11"), ("Source proof", "vitest 1857/225 \u00b7 Rust 600"), ("Windows build", "app + MSI + NSIS \u00b7 unsigned")],
    ]

    toc = TableOfContents()
    toc.levelStyles = [STYLES["toc1"], STYLES["toc2"]]

    story = cover(meta)
    story.append(Paragraph("Contents", STYLES["h2"]))
    story.append(Spacer(1, 6))
    story.append(toc)
    story.extend(parse_blocks(lines, doc.width, source.parent))
    doc.multiBuild(story)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    render(args.source.resolve(), args.destination.resolve())


if __name__ == "__main__":
    main()
