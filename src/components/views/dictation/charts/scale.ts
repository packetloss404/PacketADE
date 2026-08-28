/**
 * Minimal scale/shape arithmetic for the dictation analytics charts.
 *
 * This is the deliberate replacement for the `d3-scale` / `d3-shape` /
 * `d3-array` / `d3-time-format` package set. See
 * `dev/dictation-analytics-charting.md` for the decision and the measured
 * evidence behind it. The short version: once `d3.select` and `d3-axis` are
 * dropped — and they must be, because imperative DOM mutation is wrong in
 * React and `d3-axis` emits `<g>` subtrees that can only be styled through
 * global CSS with hardcoded colours — the remaining surface is the arithmetic
 * in this file.
 *
 * Everything here is pure and synchronously testable: no DOM, no React.
 */

export interface Point {
  x: number;
  y: number;
}

export interface LinearScale {
  (value: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  /** Human-friendly tick values inside the domain. */
  ticks(count: number): number[];
}

/**
 * Continuous linear map from `domain` to `range`.
 *
 * Replaces both `d3.scaleLinear` and `d3.scaleTime` — a time scale is a linear
 * scale over `Date.getTime()`, and none of the analytics charts use the parts
 * of `scaleTime` that differ (calendar-aware `.nice()` or `.ticks()`).
 *
 * A degenerate domain (`d0 === d1`, which is exactly what a single datapoint
 * or an all-equal series produces) maps to the midpoint of the range instead
 * of dividing by zero. This is the single-datapoint case hand-rolled charts
 * usually get wrong; d3 pins it to `range[0]`, drawing the point flush against
 * the left axis, whereas centring it reads correctly.
 */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;

  const scale = ((value: number): number => {
    if (!Number.isFinite(value) || span === 0) return (r0 + r1) / 2;
    return r0 + ((value - d0) / span) * (r1 - r0);
  }) as {
    (value: number): number;
    domain: readonly [number, number];
    range: readonly [number, number];
    ticks(count: number): number[];
  };

  scale.domain = domain;
  scale.range = range;
  scale.ticks = (count: number) => ticks(d0, d1, count);
  return scale as LinearScale;
}

export interface BandScale {
  /** Left (or top) edge of band `index`. */
  start(index: number): number;
  bandwidth: number;
  step: number;
}

/**
 * Band scale for categorical axes (hour-of-day bars, topic rows).
 * Replaces `d3.scaleBand`.
 */
export function bandScale(
  count: number,
  range: readonly [number, number],
  padding = 0.1,
): BandScale {
  const [r0, r1] = range;
  const safeCount = Math.max(1, count);
  const step = (r1 - r0) / safeCount;
  const bandwidth = Math.max(0, step * (1 - padding));
  return {
    start: (index: number) => r0 + index * step + (step - bandwidth) / 2,
    bandwidth,
    step,
  };
}

const E10 = Math.sqrt(50);
const E5 = Math.sqrt(10);
const E2 = Math.sqrt(2);

/**
 * Tick index bounds and increment, ported from `d3-array`'s `tickSpec`.
 *
 * The naive `Math.ceil(start / step)` form is wrong at float boundaries:
 * `ticks(0, 0.35, 5)` drops the final `0.35` because `0.35 / 0.05` evaluates to
 * `6.999999999999999`. Working in integer index space with a reciprocal
 * increment for sub-unit steps is what makes the axis end on the data.
 */
function tickSpec(
  start: number,
  stop: number,
  count: number,
): [i1: number, i2: number, inc: number] {
  const rough = (stop - start) / Math.max(0, count);
  const power = Math.floor(Math.log10(rough));
  const error = rough / Math.pow(10, power);
  const factor = error >= E10 ? 10 : error >= E5 ? 5 : error >= E2 ? 2 : 1;
  let i1: number;
  let i2: number;
  let inc: number;

  if (power < 0) {
    inc = Math.pow(10, -power) / factor;
    i1 = Math.round(start * inc);
    i2 = Math.round(stop * inc);
    if (i1 / inc < start) i1 += 1;
    if (i2 / inc > stop) i2 -= 1;
    inc = -inc;
  } else {
    inc = Math.pow(10, power) * factor;
    i1 = Math.round(start / inc);
    i2 = Math.round(stop / inc);
    if (i1 * inc < start) i1 += 1;
    if (i2 * inc > stop) i2 -= 1;
  }

  return [i1, i2, inc];
}

/** `d3.tickStep` — the 1/2/5/10 progression that keeps tick labels readable. */
export function tickStep(start: number, stop: number, count: number): number {
  const lo = Math.min(start, stop);
  const hi = Math.max(start, stop);
  if (lo === hi || !Number.isFinite(lo) || !Number.isFinite(hi)) return 1;
  const inc = tickSpec(lo, hi, Math.max(1, count))[2];
  return inc < 0 ? 1 / -inc : inc;
}

/** `d3.ticks` — round values spanning `[start, stop]`. */
export function ticks(start: number, stop: number, count: number): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(stop)) return [];
  if (start === stop) return [start];
  const reverse = stop < start;
  const lo = reverse ? stop : start;
  const hi = reverse ? start : stop;
  const [i1, i2, inc] = tickSpec(lo, hi, Math.max(1, count));
  if (!(i2 >= i1)) return [];

  const length = i2 - i1 + 1;
  const out: number[] = new Array<number>(length);
  for (let i = 0; i < length; i += 1) {
    // Sub-unit steps divide rather than multiply, which is what keeps values
    // like 0.3 from drifting to 0.30000000000000004.
    out[i] = inc < 0 ? (i1 + i) / -inc : (i1 + i) * inc;
  }
  return reverse ? out.reverse() : out;
}

/**
 * Upper bound rounded up to the next tick boundary. Replaces the
 * `d3.max(...) * 1.1` headroom hack in the vibe2text renderers, which yields
 * axis labels like `4180` where `4500` was wanted.
 */
export function niceUpperBound(max: number, count = 4): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const step = tickStep(0, max, count);
  return Math.ceil(max / step) * step;
}

/** `d3.extent`, returning `null` rather than a `[undefined, undefined]` union. */
export function extent(values: readonly number[]): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
    seen = true;
  }
  return seen ? [lo, hi] : null;
}

function signOf(value: number): number {
  return value < 0 ? -1 : 1;
}

/**
 * Fritsch-Carlson monotone tangent for an interior point. Ported from
 * `d3-shape`'s `slope3` so `curve: "monotone"` renders identically to the
 * `d3.curveMonotoneX` used by every vibe2text time-series chart.
 */
function slope3(p0: Point, p1: Point, p2: Point): number {
  const h0 = p1.x - p0.x;
  const h1 = p2.x - p1.x;
  const s0 = (p1.y - p0.y) / (h0 || (h1 < 0 ? -0 : 0));
  const s1 = (p2.y - p1.y) / (h1 || (h0 < 0 ? -0 : 0));
  const p = (s0 * h1 + s1 * h0) / (h0 + h1);
  return (signOf(s0) + signOf(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
}

/**
 * One-sided endpoint tangent (`d3-shape`'s `slope2`). `edge` is the terminal
 * point, `inner` its neighbour, `innerTangent` that neighbour's slope3 value.
 *
 * Direction-agnostic: at the trailing end both `h` and the rise flip sign, so
 * the quotient matches d3's leading-end formulation without a special case.
 */
function slope2(edge: Point, inner: Point, innerTangent: number): number {
  const h = inner.x - edge.x;
  if (!h) return innerTangent;
  return ((3 * (inner.y - edge.y)) / h - innerTangent) / 2;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export type Curve = "monotone" | "linear";

/**
 * SVG path data for a polyline or a monotone cubic through `points`.
 *
 * Returns `""` for an empty series and a bare `M` command for a single point,
 * so callers branch on series length rather than on path syntax.
 */
export function linePath(points: readonly Point[], curve: Curve = "monotone"): string {
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M${round(points[0].x)},${round(points[0].y)}`;
  if (n === 2 || curve === "linear") {
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${round(p.x)},${round(p.y)}`).join("");
  }

  const tangents: number[] = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i += 1) {
    tangents[i] = slope3(points[i - 1], points[i], points[i + 1]);
  }
  tangents[0] = slope2(points[0], points[1], tangents[1]);
  tangents[n - 1] = slope2(points[n - 1], points[n - 2], tangents[n - 2]);

  let d = `M${round(points[0].x)},${round(points[0].y)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = (b.x - a.x) / 3;
    d += `C${round(a.x + dx)},${round(a.y + dx * tangents[i])},${round(
      b.x - dx,
    )},${round(b.y - dx * tangents[i + 1])},${round(b.x)},${round(b.y)}`;
  }
  return d;
}

/**
 * Closed area path between the series and a flat `baselineY`.
 * Reuses `linePath`, so the fill's top edge is exactly the stroked line.
 */
export function areaPath(
  points: readonly Point[],
  baselineY: number,
  curve: Curve = "monotone",
): string {
  if (points.length < 2) return "";
  const top = linePath(points, curve);
  const first = points[0];
  const last = points[points.length - 1];
  return `${top}L${round(last.x)},${round(baselineY)}L${round(first.x)},${round(baselineY)}Z`;
}

const DATE_LABEL = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** `d3.timeFormat("%b %d")`, but locale-aware rather than en-US-hardcoded. */
export function formatDateLabel(value: number | string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return DATE_LABEL.format(date);
}

const COMPACT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** `d3.format` stand-in for the vocabulary-growth axis. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "";
  return Math.abs(value) < 1000 ? String(Math.round(value * 100) / 100) : COMPACT.format(value);
}

/**
 * Evenly spaced sample of at most `count` indices across `length` items,
 * always including the first and last.
 *
 * Used for x-axis labels. Sampling real data indices puts every tick on an
 * actual datapoint, which `d3.axisBottom(timeScale).ticks(5)` does not
 * guarantee — it picks calendar-round instants that may fall between samples.
 */
export function sampleIndices(length: number, count: number): number[] {
  if (length <= 0) return [];
  if (length === 1) return [0];
  const n = Math.max(2, Math.min(count, length));
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(Math.round((i * (length - 1)) / (n - 1)));
  }
  return Array.from(new Set(out));
}
