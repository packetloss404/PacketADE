# Dictation Analytics — Charting Approach

Status: **DONE**. Primitives and panel composition both landed in
`9c894723`; `DictationView`'s Analytics tab renders the whole inventory and
the hand-rolled strips it replaced are gone.
Decided: 2026-08-28. Branch: `feat/dictation-analytics`.

---

## 0. Decision

**Hand-rolled SVG and CSS primitives. No charting dependency. Nothing is added to
`package.json`.**

Three primitives now exist under `src/components/views/dictation/charts/` and
cover every visualisation in the analytics set. The scale and shape arithmetic
that d3 would have supplied is 325 lines in `charts/scale.ts`, verified
numerically against the real `d3-shape`, `d3-array`, and `d3-scale` packages.

The reasoning is **not** bundle size. That argument does not survive contact
with the numbers (§2) and is explicitly rejected below. The reasoning is that
the two parts of d3 that are genuinely laborious to reimplement — `d3-select`
and `d3-axis` — are exactly the two parts this app cannot use, and what remains
after removing them is arithmetic.

---

## 1. What the source actually does

Measured against `D:\projects\vibe2text\src\analytics.js` (2085 lines; the
render functions run 550–1967) and its vendored `src/lib/d3.min.js`
(279,708 bytes, not an npm dependency).

**23 render functions**, not ~20. Three are absent from the brief's inventory:
`renderModeDonut`, `renderWordCloud`, `renderTopicSpeedMood`.

**71 `d3.*` call sites. 29 of them — 41% — are `d3.select`.** Thirteen of the
23 renderers touch d3 *only* through `d3.select`; they are HTML builders that
happen to use d3 as a DOM helper.

| d3 API | Call sites | Fate in PacketBench |
| --- | --- | --- |
| `d3.select` | 29 | **Dropped.** Imperative DOM mutation; React owns the DOM. |
| `d3.curveMonotoneX` | 12 | Ported to `scale.ts` (Fritsch–Carlson, verified identical). |
| `d3.scaleLinear` | 11 | 9 geometry uses → `linearScale`. 2 are **colour** ramps (see below). |
| `d3.axisLeft` / `d3.axisBottom` | 16 | **Dropped.** Emits `<g><path class="domain">` subtrees styleable only via global CSS with hardcoded hex — incompatible with the theme-token rule. Axes are rendered in JSX instead. |
| `d3.max` / `d3.min` / `d3.extent` / `d3.range` | 25 | `Math.max`, `extent()`, `Array.from`. |
| `d3.scaleTime` | 6 | `linearScale` over `Date.getTime()`. No calendar-aware `.nice()` or `.ticks()` is used anywhere. |
| `d3.line` / `d3.area` | 12 | `linePath()` / `areaPath()`. |
| `d3.timeFormat` | 6 | `Intl.DateTimeFormat` (and now locale-aware rather than en-US-hardcoded). |
| `d3.format` | 1 | `Intl.NumberFormat`. |
| `d3.scaleBand` | 2 | Flexbox already does band layout; `bandScale()` exists for SVG cases. |
| `d3.arc` / `d3.pie` | 3 | **Not ported** — the donut is out of scope (§3). |

Two findings worth flagging:

- **The heatmaps' `scaleLinear` is not a geometry scale.** Both
  `renderActivityHeatmap` and `renderYearlyHeatmap` do
  `d3.scaleLinear().domain([0, max]).range([CHART_COLORS.bg, CHART_COLORS.accent])`
  — an RGB interpolation between two hex literals, via `d3-interpolate`. That
  construction is *unavailable* here regardless of dependency choice:
  PacketBench's theme colours are `color-mix()` custom properties that change
  between the dark and light themes in `src/index.css`, so there is no hex pair
  to interpolate. Bucketed opacity classes are the only correct answer.
- **`d3.axisLeft(y).tickSize(-width).tickFormat('')`** is how every chart draws
  its grid — a d3 axis abused as a grid generator. Four `<line>` elements in
  JSX replace it.

---

## 2. Measured cost of the alternative

Measured 2026-08-28. Sizes from `npm view <pkg> dist.unpackedSize`; bundle
figures from esbuild `--bundle --minify --format=esm` over an entry importing
exactly the APIs `analytics.js` uses, minus `d3.select`.

### Install footprint

`pnpm add d3-scale d3-shape d3-array d3-time-format` resolves to **10 runtime
packages**, because `d3-scale` alone pulls `d3-array`, `d3-format`,
`d3-interpolate`, `d3-time`, and `d3-time-format`, which pull `internmap`,
`d3-color`, and `d3-path`:

| Package | Unpacked |
| --- | --- |
| d3-shape 3.2.0 | 247,267 |
| d3-scale 4.0.2 | 174,363 |
| d3-array 3.2.4 | 163,730 |
| d3-time-format 4.1.0 | 85,603 |
| d3-interpolate 3.0.1 | 69,687 |
| d3-time 3.1.0 | 64,483 |
| d3-color 3.1.0 | 61,152 |
| d3-format 3.1.2 | 42,342 |
| d3-path 3.1.0 | 20,858 |
| internmap 2.0.3 | 10,470 |
| **Total** | **939,955 B / 356 files** |

d3 packages ship no TypeScript types, so `strict` mode also requires **8
DefinitelyTyped dev packages** (`@types/d3-{scale,shape,array,time-format,path,time,color,interpolate}`)
totalling a further **433,271 B**. Eighteen new dependency edges in all.

### Bundle footprint

| Approach | Minified | Gzipped |
| --- | --- | --- |
| Modular d3, all 14 APIs used | 48,978 B | 17,268 B |
| Modular d3, time-series subset only | 41,661 B | 14,759 B |
| **`charts/scale.ts` (this repo)** | **3,011 B** | **1,458 B** |
| Vendored `d3.min.js` (vibe2text) | 279,708 B | n/a — loaded from disk uncompressed, no tree-shaking |

### Reading the numbers honestly

**The brief's assumption that modular d3 beats the monolith is correct on
bundle bytes and wrong on install footprint** — 940 KB across 10 packages
versus one 280 KB file — but neither figure should decide anything. PacketBench
ships as a Tauri bundle that already embeds a pinned Node 24.15.0 runtime, the
pruned sidecar `node_modules`, xterm.js and its WebGL addon. **17 KB gzipped is
noise in that context, and no decision here should be justified by it.** The
~12× difference against the hand-rolled maths is real and irrelevant.

The costs that *do* matter:

1. **It is a rewrite either way.** 41% of the d3 call sites are `d3.select`.
   Taking the dependency does not let you port the vibe2text renderers; every
   one of them still has to be rewritten as JSX. You would pay 18 dependency
   edges and gain no reused code.
2. **The theme-token rule excludes `d3-axis` and `d3-select`.** Both write
   colours and structure into the DOM that can only be reached with global CSS
   and literal colour values. CLAUDE.md forbids that. Once they are out, the
   remaining d3 surface is ~60 lines of arithmetic behind 18 dependency edges.
3. **Supply chain and types.** Eight DefinitelyTyped packages, separately
   versioned from the runtime packages they describe, for arithmetic that is
   fully specified by a 1980 paper and verifiable in a unit test.
4. **A React-native library (Recharts, Victory) is a worse fit still.**
   Recharts unpacks at 7.45 MB and depends on Redux Toolkit, immer, reselect,
   react-redux, and `victory-vendor` (which itself vendors d3). Victory unpacks
   at 2.28 MB across 12 sibling packages. Both impose their own theming model,
   which would have to be fought to honour the token palette.

### What the hand-rolled maths had to earn

The claim "it's just arithmetic" is only worth acting on if it is true at the
hard point, which is `curveMonotoneX`. It was tested rather than asserted:

- **400 randomised series** (3–43 points, including plateaus, all-equal runs,
  and negative values) rendered through both `d3-shape@3.2.0`'s
  `line().curve(curveMonotoneX)` and `linePath(..., "monotone")`:
  **0 structural failures, maximum coordinate delta 0.01** — exactly the 2-dp
  rounding applied on purpose to keep the path data small.
- **8,060 tick cases** against `d3-array@3.2.4`'s `ticks` and `tickStep`:
  **0 mismatches**. This required porting d3's integer-space `tickSpec` rather
  than the naive `Math.ceil(start / step)` form, which drops the final tick of
  `ticks(0, 0.35, 5)` because `0.35 / 0.05` evaluates to `6.999999999999999`.

Both checks are pinned as fixtures in `charts/charts.test.tsx`, with the
expected strings generated from the real d3 packages, so a future edit to
`scale.ts` that breaks parity fails the suite.

---

## 3. The 13/7 split — corrected

The brief's split does not survive the source. Two substantive corrections and
one scope change.

**Correction 1 — `renderWpmByHour` is not a time-series chart.** The brief
places it with the six line/area charts. It is a categorical bar chart:
`d3.scaleBand().domain(d3.range(24))` for x, `d3.scaleLinear` for bar height,
`d3.axisBottom` with four fixed hour ticks. No time axis, no line, no area, no
curve. Its geometry need is `value / max * 100%` — which is precisely what the
existing hourly-activity strip in `DictationView.tsx` (~line 442) already does
with flex divs. **It belongs with the bars.**

**Correction 2 — the heatmaps are in the right group, for a stronger reason
than stated.** Their `scaleLinear` never touches geometry; it is a colour
interpolator that cannot be reproduced against `color-mix()` theme tokens at
all (§1). They need a bucketing function, not a scale.

**Scope change.** `src/types/dictation.ts` — landed by the aggregates agent
during this work — documents that the **mode donut and topic classification are
deliberately not ported** (`modeBreakdown` is always a single `transcribe`
bucket; the topic keyword rules were tuned to a different product). That
removes `renderModeDonut`, `renderTopicSpeedMood`, and the word cloud from the
inventory and makes `d3.arc` / `d3.pie` moot.

Against the real `DictationAnalytics` payload the inventory is **21
visualisations**, split **6 / 15**:

| Needs scale + shape maths (6) | Needs no scale abstraction (15) |
| --- | --- |
| Words per day | Yearly heatmap · 7×24 activity heatmap |
| Time saved | Peak hours · **WPM by hour** · Top words |
| Cumulative talking time | Filler words · Rare words · Common phrases |
| WPM over time | Word-length distribution · Goals · Period comparison |
| Vocabulary growth | Streaks · Records · New words this week · Reading level |
| Sentiment over time | |

So: **six, not seven.** And 21 panels, not 20 — the brief's list omits top
words and counts bigrams and trigrams as one.

---

## 4. The primitives

All under `src/components/views/dictation/charts/`. Import components from the
`index.ts` barrel; import maths from `./scale` and tone classes from `./tokens`
directly (the barrel deliberately re-exports no values other than components,
so `react-refresh/only-export-components` stays quiet).

### Shared rules these encode

- **Theme tokens only.** Every colour resolves through a `--color-*` custom
  property. `accent-cyan`, `accent-yellow`, `accent-orange`, and
  `text-text-tertiary` are used elsewhere in the app but are **undefined in
  `tailwind.config.ts`** and render colourless; `tokens.ts` offers only
  `green | blue | amber | purple | red`, which are the tones that exist.
- **Tailwind cannot see computed class names.** `` `bg-accent-${tone}/40` ``
  is never generated. Every ramp step in `tokens.ts` is spelled out as a
  literal. That verbosity is load-bearing — do not refactor it into template
  literals.
- **Accessibility is in the frame, not per chart.** `ChartFrame` gives every
  panel a `role="group"` accessible name carrying the headline numbers, and a
  keyboard-reachable `<details>` data table. The SVG or grid is always
  `aria-hidden`; it is decoration over a real text alternative.
- **Compact idiom.** `text-[10px]` / `text-[11px]` labels, `text-xs` body,
  matching the surrounding Dictation UI.

### `TimeSeriesChart` — the six maths charts

```ts
interface TimeSeriesPoint { date: string | number | Date; value: number }

interface TimeSeriesChartProps {
  title: string;
  data: readonly TimeSeriesPoint[];
  variant?: "area" | "line" | "diverging";   // default "area"
  tone?: ChartTone;                          // default "green"
  negativeTone?: ChartTone;                  // default "red"; diverging only
  yBaseline?: "zero" | "extent";             // default "zero"
  curve?: "monotone" | "linear";             // default "monotone"
  height?: number;                           // plot px, default 96
  unit?: string;                             // e.g. "words"
  valueFormat?: (value: number) => string;   // default formatCompact
  emptyLabel?: string;
  className?: string;
}
```

| Visualisation | Call it as |
| --- | --- |
| Words per day | `variant="area" tone="green" unit="words"` |
| Time saved | `variant="area" tone="blue" unit="min"` |
| Cumulative talking time | `variant="area" tone="purple" unit="min"` |
| WPM over time | `variant="line" yBaseline="extent" unit="wpm"` |
| Vocabulary growth | `variant="area" tone="amber" unit="words"` |
| Sentiment over time | `variant="diverging" tone="green" negativeTone="red"` |

Two behaviours differ from the vibe2text originals on purpose:

- **Width comes from a `ResizeObserver`, not a one-shot
  `getBoundingClientRect()`.** Every vibe2text chart bails with
  `if (width <= 0) return;` and renders *nothing* when its panel is laid out
  later or starts hidden. That is a real blank-chart bug; do not reintroduce
  it. A fallback width keeps the chart rendering before first measurement and
  under jsdom.
- **The value axis ends on a round tick** (`niceUpperBound`) instead of
  `d3.max(...) * 1.1`, which produced axis labels like `4598`.

### `HeatmapGrid` — both heatmaps

```ts
interface HeatmapGridProps {
  title: string;
  rows: readonly (readonly number[])[];          // row-major; ragged rows pad with 0
  rowLabels: readonly string[];
  columnLabels?: readonly (string | null)[];     // sparse; null renders nothing
  cellSize?: number;                             // default 12
  cellGap?: number;                              // default 2
  tone?: ChartTone;
  cellLabel?: (rowIndex: number, columnIndex: number) => string;
  unit?: string;                                 // default "entries"
  showLegend?: boolean;                          // default true
  emptyLabel?: string;
  className?: string;
}
```

| Visualisation | Call it as |
| --- | --- |
| 7×24 activity heatmap | `rows={analytics.activityMatrix}` with weekday `rowLabels` and sparse hour `columnLabels` |
| Yearly (GitHub-style) heatmap | Pivot `dailySeries` into 7 weekday rows × ~53 week columns; `cellSize={10}`, month names as `columnLabels` |

HTML boxes rather than SVG `<rect>`s: native `title` tooltips, flexbox layout,
and an opacity ramp that tracks both themes.

### `BarSeries` — the other fifteen

```ts
interface BarDatum {
  label: string;
  value: number | null;      // null = "no reading", rendered distinctly from 0
  tone?: ChartTone;          // per-bar override
  note?: string;             // trailing text on horizontal rows
}

interface BarSeriesProps {
  title: string;
  data: readonly BarDatum[];
  orientation?: "vertical" | "horizontal";   // default "vertical"
  tone?: ChartTone;
  axisLabels?: readonly (string | null)[];   // vertical only, sparse
  height?: number;                           // vertical px, default 56
  maxValue?: number;                         // shared ceiling across panels
  unit?: string;
  valueFormat?: (value: number) => string;
  showValues?: boolean;                      // horizontal only, default true
  emptyLabel?: string;
  className?: string;
}
```

| Visualisation | Call it as |
| --- | --- |
| Peak hours | `vertical`, `hourlyActivity`, sparse `axisLabels` at 0/6/12/18 |
| WPM by hour | `vertical`, `wpmByHour` — the `null` slots render as empty ticks, not zero bars |
| Top words | `horizontal`, `topWords`, `tone="purple"` |
| Filler words | `horizontal`, `fillerCounts`, `tone="amber"` |
| Rare words | `horizontal`, `rareWords` |
| Common phrases | `horizontal`, `topBigrams` and `topTrigrams` as two panels |
| Word-length distribution | `horizontal`, three buckets from `wordLengths` |
| Goals | `horizontal`, `maxValue={dailyWordGoal}` / `{weeklyWordGoal}` |
| Period comparison | `horizontal`, `thisWeek` vs `lastWeek` with a **shared** `maxValue` |

Geometry is CSS percentage width/height — no scale object, no measurement, no
reflow bug, correct at every container size including zero.

### Not served by a primitive (4)

Streaks, records, new-words-this-week, and reading level are numbers and lists.
Render them as stat tiles and chips directly in the panel; wrapping them in
`ChartFrame` is optional but gives free accessible naming.

---

## 5. Files

| Path | Lines | Role |
| --- | --- | --- |
| `charts/scale.ts` | 325 | All scale/shape maths. Pure, no DOM, no React. |
| `charts/tokens.ts` | 146 | Tone → literal Tailwind class maps and the intensity ramp. |
| `charts/ChartFrame.tsx` | 136 | Panel chrome, empty state, accessible name, data table. |
| `charts/TimeSeriesChart.tsx` | ~345 | Line/area/diverging with axes. |
| `charts/HeatmapGrid.tsx` | 189 | Cell grid with intensity ramp. |
| `charts/BarSeries.tsx` | 186 | Vertical and horizontal categorical bars. |
| `charts/charts.test.tsx` | 22 tests | d3-parity fixtures and degenerate-input renders. |
| `charts/index.ts` | 23 | Component and type barrel. |

**No dependency is required and none was added.** For the record, had the
modular-d3 route been taken the command would have been:

```bash
pnpm add d3-scale d3-shape d3-array d3-time-format
pnpm add -D @types/d3-scale @types/d3-shape @types/d3-array @types/d3-time-format
```

(the other six runtime and four type packages arrive transitively). `package.json`
is owned by another agent, so this is reported, not executed — and the
recommendation is not to run it.

---

## 6. Gates

Run 2026-08-28 on `feat/dictation-analytics`:

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | **0 errors** |
| `pnpm lint` | **0 errors**, 9 warnings — all nine pre-existing `react-refresh/only-export-components` in files outside this work |
| `npx eslint src/components/views/dictation --max-warnings=0` | **clean** |
| `npx vitest run src/components/views/dictation/charts` | **22 passed / 22** |

Re-run 2026-08-28 after panel composition landed, over the whole dictation
frontend rather than the primitives alone:

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | **0 errors** |
| `npx eslint src/components/views/dictation src/components/views/DictationView.tsx --max-warnings=0` | **clean** |
| `npx vitest run src/components/views/dictation` | **54 passed / 54** (3 files) |

---

## 7. For the panel-building agent — landed

The panel was built to this section; it now reads as the rules the panel
keeps rather than work outstanding. Composition lives in
`src/components/views/dictation/`: `AnalyticsPanel.tsx` (headline tiles,
streaks, goals, records) delegating to `AnalyticsTrends.tsx`,
`AnalyticsRhythm.tsx`, and `AnalyticsVocabulary.tsx`, over the pure
derivations in `analytics-derive.ts`. Point 6 is discharged — every strip it
names, mode breakdown included, was deleted from `DictationView.tsx`.

1. **Compose, do not extend.** Every panel should be a `TimeSeriesChart`,
   `HeatmapGrid`, or `BarSeries` call plus data shaping. If a panel seems to
   need a new primitive, it more likely needs a new prop.
2. **Derive on the client.** `DictationDailyPoint` is one series backing seven
   charts. Time saved, cumulative talking time, and the yearly-heatmap lookup
   are all derived from it — the doc comments in `src/types/dictation.ts` give
   the exact formulas, including seeding cumulative charts from
   `dailySeriesCarry` so they do not restart at zero when the window truncates.
3. **Gate sentiment on coverage.** `sentimentCoverage.scoredDays` is the number
   of points the sentiment series actually has. Label it ("scored 12 of 840
   entries") and treat `averageSentiment` as *no data* rather than *neutral*
   when `scoredEntries` is 0.
4. **Bucketing is UTC.** Every calendar bucket in the payload — hour,
   day-of-week, "today", "this week" — is UTC, because the Rust side has no tz
   database. Hour-of-day labels are UTC hours; say so in the panel or the
   numbers will read as wrong to anyone not on UTC.
5. **Do not add colours.** If a panel wants a sixth tone, it wants one of the
   five that exist. Adding `accent-cyan` to `tailwind.config.ts` is a separate,
   app-wide change with its own light-theme obligations — several call sites
   already reference undefined tones and render colourless.
6. **Retire the hand-rolled strips in `DictationView.tsx`** — "Sentiment Over
   Time" (~line 366), "WPM Over Time" (~line 416), "Activity by Hour"
   (~line 444), "Top Words" (~line 473), and "Words per Entry" (~line 520) —
   once the new panel covers them. They duplicate what `TimeSeriesChart` and
   `BarSeries` now do and carry no text alternative. "Mode Breakdown"
   (~line 496) should go too: `modeBreakdown` is documented as a permanently
   single-bucket field.
