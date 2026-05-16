import { useMemo, type CSSProperties, type ReactNode } from "react";

/**
 * Tiny, dependency-free ANSI SGR parser → styled React spans.
 *
 * Built for the Code Quality / diagnostics runner output stream. We render
 * raw stdout/stderr from `eslint`, `tsc`, `cargo`, `pnpm test`, etc., all of
 * which sprinkle SGR escapes (`\x1b[<n>m`). xterm.js handles this in our
 * PTY panes but a full xterm in a modal is overkill for line-oriented
 * diagnostic output — we just want colored text.
 *
 * Supported:
 *   - Standard foreground 30–37 + bright 90–97
 *   - Standard background 40–47 + bright 100–107
 *   - Bold (1), dim (2), italic (3), underline (4)
 *   - Reset (0 or empty)
 *   - 256-color `38;5;N` and 24-bit `38;2;R;G;B`
 *
 * Not supported (silently dropped):
 *   - Blink, reverse video, hidden, strikethrough — rarely emitted by
 *     compilers and noisy when rendered in a flat output panel.
 *
 * Performance: parsing is O(n) over the input. We memoise on `text` so
 * scrolling/re-renders of an unchanged buffer are free.
 */

interface AnsiTextProps {
  text: string;
  /** Optional wrapper className applied to the outer pre. */
  className?: string;
  /** When set, lines containing this substring (case-insensitive) are
   *  rendered. Empty string = no filter. */
  filter?: string;
  /** Highlight matches of `filter` inside the rendered text. */
  highlightFilter?: boolean;
  /** Optional click handler for `path:line:col` style tokens. The handler
   *  receives the parsed file path and 1-based line/column. */
  onPathClick?: (path: string, line: number, col: number | null) => void;
}

// Standard 16-color palette using our theme tokens where possible. We use
// raw hex so the colors land regardless of CSS variable availability.
const FG_COLORS: Record<number, string> = {
  30: "#5c6370", // black → muted (legible on dark bg)
  31: "#f85149", // red
  32: "#56d364",
  33: "#f0b400",
  34: "#58a6ff",
  35: "#bc8cff",
  36: "#39c5cf",
  37: "#c9d1d9", // white → primary text
  90: "#7a828e",
  91: "#ff7b72",
  92: "#7ee787",
  93: "#f2cc60",
  94: "#79c0ff",
  95: "#d2a8ff",
  96: "#56d4dd",
  97: "#f0f6fc",
};

const BG_COLORS: Record<number, string> = {
  40: "#1f2428",
  41: "#67060c",
  42: "#0d3320",
  43: "#542800",
  44: "#0c2d6b",
  45: "#3c1361",
  46: "#0a3036",
  47: "#1c2128",
  100: "#2d333b",
  101: "#8e1519",
  102: "#196c2e",
  103: "#7d4e00",
  104: "#1f6feb",
  105: "#6e40c9",
  106: "#1b7c83",
  107: "#3d444d",
};

// 6×6×6 cube + 24 grayscale, for 256-color codes 16..255.
function color256(n: number): string {
  if (n < 16) {
    const m: Record<number, string> = { 0: "#000", 1: "#cd3131", 2: "#0dbc79", 3: "#e5e510", 4: "#2472c8", 5: "#bc3fbc", 6: "#11a8cd", 7: "#e5e5e5", 8: "#666", 9: "#f14c4c", 10: "#23d18b", 11: "#f5f543", 12: "#3b8eea", 13: "#d670d6", 14: "#29b8db", 15: "#fff" };
    return m[n] || "#c9d1d9";
  }
  if (n < 232) {
    const k = n - 16;
    const r = Math.floor(k / 36);
    const g = Math.floor((k % 36) / 6);
    const b = k % 6;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v}, ${v}, ${v})`;
}

interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

function emptyStyle(): Style {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
}

function applyCodes(style: Style, codes: number[]): Style {
  let s = { ...style };
  let i = 0;
  while (i < codes.length) {
    const c = codes[i];
    if (c === 0) {
      s = emptyStyle();
    } else if (c === 1) {
      s.bold = true;
    } else if (c === 2) {
      s.dim = true;
    } else if (c === 3) {
      s.italic = true;
    } else if (c === 4) {
      s.underline = true;
    } else if (c === 22) {
      s.bold = false;
      s.dim = false;
    } else if (c === 23) {
      s.italic = false;
    } else if (c === 24) {
      s.underline = false;
    } else if (c === 39) {
      s.fg = null;
    } else if (c === 49) {
      s.bg = null;
    } else if (c === 38 && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
      s.fg = color256(codes[i + 2]);
      i += 2;
    } else if (c === 48 && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
      s.bg = color256(codes[i + 2]);
      i += 2;
    } else if (c === 38 && codes[i + 1] === 2 && codes[i + 4] !== undefined) {
      s.fg = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`;
      i += 4;
    } else if (c === 48 && codes[i + 1] === 2 && codes[i + 4] !== undefined) {
      s.bg = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`;
      i += 4;
    } else if (c in FG_COLORS) {
      s.fg = FG_COLORS[c];
    } else if (c in BG_COLORS) {
      s.bg = BG_COLORS[c];
    }
    i += 1;
  }
  return s;
}

function styleToCss(s: Style): CSSProperties {
  const css: CSSProperties = {};
  if (s.fg) css.color = s.fg;
  if (s.bg) css.backgroundColor = s.bg;
  if (s.bold) css.fontWeight = 700;
  if (s.dim) css.opacity = 0.7;
  if (s.italic) css.fontStyle = "italic";
  if (s.underline) css.textDecoration = "underline";
  return css;
}

// Match `path:line:col` or `path:line` anywhere in a string. Windows drive
// letters supported via the `(?:[A-Za-z]:)?` prefix. The path body excludes
// whitespace and colons.
const PATH_LINE_RE = /((?:[A-Za-z]:)?[\w./\\@~-]+\.[a-zA-Z]{1,8}):(\d+)(?::(\d+))?/g;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-9;]*)m/g;

interface Segment {
  text: string;
  style: Style;
}

function tokenize(text: string): Segment[] {
  const out: Segment[] = [];
  let style = emptyStyle();
  let last = 0;
  ANSI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSI_RE.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ text: text.slice(last, m.index), style });
    }
    const codes = m[1].length === 0 ? [0] : m[1].split(";").map((s) => parseInt(s, 10) || 0);
    style = applyCodes(style, codes);
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ text: text.slice(last), style });
  }
  return out;
}

/**
 * Split a plain segment into spans, linkifying `path:line:col` matches when
 * `onPathClick` is provided. Returns the list of React children for the
 * caller to wrap in a styled span.
 */
function renderSegment(
  seg: Segment,
  key: string,
  filter: string,
  highlightFilter: boolean,
  onPathClick: AnsiTextProps["onPathClick"],
): ReactNode {
  const css = styleToCss(seg.style);
  const children: ReactNode[] = [];

  if (onPathClick && seg.text.length > 0) {
    let last = 0;
    PATH_LINE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_LINE_RE.exec(seg.text)) !== null) {
      if (m.index > last) {
        children.push(highlightInline(seg.text.slice(last, m.index), filter, highlightFilter, `${key}-t${last}`));
      }
      const path = m[1];
      const line = parseInt(m[2], 10);
      const col = m[3] ? parseInt(m[3], 10) : null;
      children.push(
        <button
          key={`${key}-l${m.index}`}
          type="button"
          onClick={() => onPathClick(path, line, col)}
          className="underline decoration-dotted decoration-text-muted hover:text-accent-blue hover:decoration-accent-blue cursor-pointer text-left"
          title="Copy path"
        >
          {m[0]}
        </button>,
      );
      last = m.index + m[0].length;
    }
    if (last < seg.text.length) {
      children.push(highlightInline(seg.text.slice(last), filter, highlightFilter, `${key}-t${last}`));
    }
  } else {
    children.push(highlightInline(seg.text, filter, highlightFilter, `${key}-t0`));
  }

  return (
    <span key={key} style={css}>
      {children}
    </span>
  );
}

function highlightInline(text: string, filter: string, highlight: boolean, key: string): ReactNode {
  if (!highlight || !filter) return <span key={key}>{text}</span>;
  const lower = text.toLowerCase();
  const target = filter.toLowerCase();
  if (!lower.includes(target)) return <span key={key}>{text}</span>;
  const parts: ReactNode[] = [];
  let i = 0;
  // Stable keys are derived from the offset into `text` so we don't end up
  // with key collisions when a single highlight straddles multiple matches.
  while (i < text.length) {
    const idx = lower.indexOf(target, i);
    if (idx < 0) {
      parts.push(<span key={`${key}-end-${i}`}>{text.slice(i)}</span>);
      break;
    }
    if (idx > i) parts.push(<span key={`${key}-pre-${i}`}>{text.slice(i, idx)}</span>);
    parts.push(
      <mark key={`${key}-hit-${idx}`} className="bg-accent-amber/30 text-text-primary px-0.5 rounded-sm">
        {text.slice(idx, idx + target.length)}
      </mark>,
    );
    i = idx + target.length;
  }
  return <>{parts}</>;
}

export function AnsiText({ text, className, filter = "", highlightFilter = false, onPathClick }: AnsiTextProps) {
  const segments = useMemo(() => tokenize(text), [text]);

  // Optional line-level filter. We tokenize first so SGR state still flows
  // across line boundaries; filtering applies on the rendered line list.
  const lines = useMemo(() => {
    // Reconstruct lines while keeping segment styling. Easiest: split each
    // segment by \n and emit one logical line per accumulated chunk.
    const acc: Segment[][] = [[]];
    for (const seg of segments) {
      const pieces = seg.text.split("\n");
      pieces.forEach((piece, idx) => {
        if (piece.length > 0) acc[acc.length - 1].push({ text: piece, style: seg.style });
        if (idx < pieces.length - 1) acc.push([]);
      });
    }
    return acc;
  }, [segments]);

  const f = filter.trim().toLowerCase();
  const visibleLines = f
    ? lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => line.map((s) => s.text).join("").toLowerCase().includes(f))
    : lines.map((line, i) => ({ line, i }));

  return (
    <pre
      className={
        "font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-text-primary " +
        (className ?? "")
      }
    >
      {visibleLines.map(({ line, i }) => (
        <div key={i} className="min-h-[1.4em]">
          {line.length === 0 ? (
            <span>&nbsp;</span>
          ) : (
            line.map((seg, j) => renderSegment(seg, `${i}-${j}`, f, highlightFilter, onPathClick))
          )}
        </div>
      ))}
      {visibleLines.length === 0 && (
        <div className="text-text-muted italic">No lines match the current filter.</div>
      )}
    </pre>
  );
}
