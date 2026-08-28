/**
 * Theme-token colour vocabulary for the dictation analytics charts.
 *
 * Two hard constraints drive this file:
 *
 * 1. CLAUDE.md forbids raw Tailwind colours and hex literals. Every chart
 *    colour must resolve through a `--color-*` custom property so it tracks
 *    both the dark and light themes in `src/index.css`.
 * 2. Tailwind only emits classes it can find as complete literal strings when
 *    it scans source. A computed class like `` `bg-accent-${tone}/40` `` is
 *    never generated and renders transparent. So every ramp step below is
 *    spelled out in full. That verbosity is load-bearing — do not "simplify"
 *    it into template literals.
 *
 * Only tones that actually exist in `tailwind.config.ts` are offered.
 * `accent-cyan`, `accent-yellow`, `accent-orange` and `text-text-tertiary`
 * appear elsewhere in the app but are **not defined**, so they render
 * colourless; they are deliberately absent here.
 */

export type ChartTone = "green" | "blue" | "amber" | "purple" | "red";

export const CHART_TONES: readonly ChartTone[] = [
  "green",
  "blue",
  "amber",
  "purple",
  "red",
] as const;

interface ToneClasses {
  /** Solid fill for bars and dots. */
  fill: string;
  /** Translucent fill for area bodies. */
  fillSoft: string;
  /** Series stroke. */
  stroke: string;
  /** Solid background for HTML bars. */
  bg: string;
  /** Hover background for HTML bars. */
  bgHover: string;
  /** Text colour for legends and value labels. */
  text: string;
  /**
   * Five-step intensity ramp, index 0 = "no activity". Used by the heatmap
   * grids in place of the `d3.scaleLinear().range([bgHex, accentHex])` RGB
   * interpolation the vibe2text renderers use — that approach cannot work
   * here, because the theme colours are `color-mix()` custom properties with
   * no hex value to interpolate between.
   */
  ramp: readonly [string, string, string, string, string];
}

export const TONE: Record<ChartTone, ToneClasses> = {
  green: {
    fill: "fill-accent-green",
    fillSoft: "fill-accent-green/20",
    stroke: "stroke-accent-green",
    bg: "bg-accent-green/60",
    bgHover: "hover:bg-accent-green/90",
    text: "text-accent-green",
    ramp: [
      "bg-bg-tertiary",
      "bg-accent-green/25",
      "bg-accent-green/45",
      "bg-accent-green/70",
      "bg-accent-green",
    ],
  },
  blue: {
    fill: "fill-accent-blue",
    fillSoft: "fill-accent-blue/20",
    stroke: "stroke-accent-blue",
    bg: "bg-accent-blue/60",
    bgHover: "hover:bg-accent-blue/90",
    text: "text-accent-blue",
    ramp: [
      "bg-bg-tertiary",
      "bg-accent-blue/25",
      "bg-accent-blue/45",
      "bg-accent-blue/70",
      "bg-accent-blue",
    ],
  },
  amber: {
    fill: "fill-accent-amber",
    fillSoft: "fill-accent-amber/20",
    stroke: "stroke-accent-amber",
    bg: "bg-accent-amber/60",
    bgHover: "hover:bg-accent-amber/90",
    text: "text-accent-amber",
    ramp: [
      "bg-bg-tertiary",
      "bg-accent-amber/25",
      "bg-accent-amber/45",
      "bg-accent-amber/70",
      "bg-accent-amber",
    ],
  },
  purple: {
    fill: "fill-accent-purple",
    fillSoft: "fill-accent-purple/20",
    stroke: "stroke-accent-purple",
    bg: "bg-accent-purple/60",
    bgHover: "hover:bg-accent-purple/90",
    text: "text-accent-purple",
    ramp: [
      "bg-bg-tertiary",
      "bg-accent-purple/25",
      "bg-accent-purple/45",
      "bg-accent-purple/70",
      "bg-accent-purple",
    ],
  },
  red: {
    fill: "fill-accent-red",
    fillSoft: "fill-accent-red/20",
    stroke: "stroke-accent-red",
    bg: "bg-accent-red/60",
    bgHover: "hover:bg-accent-red/90",
    text: "text-accent-red",
    ramp: [
      "bg-bg-tertiary",
      "bg-accent-red/25",
      "bg-accent-red/45",
      "bg-accent-red/70",
      "bg-accent-red",
    ],
  },
};

export const RAMP_STEPS = 5;

/**
 * Map a value onto a ramp index in `[0, RAMP_STEPS - 1]`.
 *
 * Zero always lands on step 0 (the empty cell) so "no activity" and "barely
 * any activity" stay visually distinct — a plain linear interpolation makes a
 * single transcription indistinguishable from none.
 */
export function rampIndex(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 1;
  const ratio = Math.min(1, value / max);
  return Math.min(RAMP_STEPS - 1, 1 + Math.floor(ratio * (RAMP_STEPS - 1)));
}
