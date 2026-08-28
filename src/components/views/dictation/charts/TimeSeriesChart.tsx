import { useEffect, useRef, useState, type RefObject } from "react";
import { ChartFrame, type ChartTableColumn } from "./ChartFrame";
import { TONE, type ChartTone } from "./tokens";
import {
  areaPath,
  extent,
  formatCompact,
  formatDateLabel,
  linePath,
  linearScale,
  niceUpperBound,
  sampleIndices,
  type Curve,
  type Point,
} from "./scale";

/**
 * Time-series line/area chart with a value axis and a date axis.
 *
 * This is the primitive for every dictation visualisation that genuinely needs
 * scale and shape maths — see `dev/dictation-analytics-charting.md` for the
 * inventory. It replaces the
 * `scaleTime + scaleLinear + area + line + curveMonotoneX + axisBottom +
 * axisLeft + timeFormat` stack that each vibe2text renderer rebuilds by hand.
 *
 * Two behaviours differ from the vibe2text originals on purpose:
 *
 * - Width comes from a `ResizeObserver`, not a one-shot
 *   `getBoundingClientRect()`. The originals bail with `if (width <= 0) return;`
 *   and render nothing at all when the panel is laid out later or starts
 *   hidden — a real, reproducible blank-chart bug.
 * - The y axis ends on a round tick (`niceUpperBound`) instead of
 *   `d3.max(...) * 1.1`, which produced axis labels like `4180`.
 */

export interface TimeSeriesPoint {
  /** ISO date string, epoch milliseconds, or `Date`. */
  date: string | number | Date;
  value: number;
}

export interface TimeSeriesChartProps {
  title: string;
  data: readonly TimeSeriesPoint[];
  /**
   * `area` fills to the baseline, `line` strokes only, `diverging` splits the
   * fill above and below zero (the sentiment chart).
   */
  variant?: "area" | "line" | "diverging";
  tone?: ChartTone;
  /** Fill tone below zero when `variant="diverging"`. */
  negativeTone?: ChartTone;
  /**
   * `zero` anchors the value axis at zero (counts, durations).
   * `extent` fits the observed range (WPM, where zero is uninformative).
   * Ignored by `variant="diverging"`, which is always symmetric about zero.
   */
  yBaseline?: "zero" | "extent";
  curve?: Curve;
  /** Plot height in px, excluding the axis gutter. Default 96. */
  height?: number;
  /** Unit noun used in the accessible summary and tooltips, e.g. "words". */
  unit?: string;
  valueFormat?: (value: number) => string;
  emptyLabel?: string;
  className?: string;
}

const PAD_LEFT = 34;
const PAD_RIGHT = 6;
const PAD_TOP = 6;
const AXIS_HEIGHT = 16;
const FALLBACK_WIDTH = 420;
const DOT_LIMIT = 60;

const TABLE_COLUMNS: ChartTableColumn[] = [
  { key: "date", label: "Date" },
  { key: "value", label: "Value", numeric: true },
];

/** Container width in px, tracked live. Falls back before first measurement. */
function useMeasuredWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // jsdom and older webviews have no ResizeObserver; the fallback width
    // keeps the chart rendering rather than collapsing to nothing.
    if (typeof ResizeObserver === "undefined") {
      setWidth(node.getBoundingClientRect().width);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width > 0 ? width : FALLBACK_WIDTH];
}

function toTime(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

export function TimeSeriesChart({
  title,
  data,
  variant = "area",
  tone = "green",
  negativeTone = "red",
  yBaseline = "zero",
  curve = "monotone",
  height = 96,
  unit,
  valueFormat = formatCompact,
  emptyLabel = "No data yet",
  className,
}: TimeSeriesChartProps) {
  const [containerRef, width] = useMeasuredWidth();

  const series = data
    .map((point) => ({ t: toTime(point.date), value: point.value }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value))
    .sort((a, b) => a.t - b.t);

  const unitSuffix = unit ? ` ${unit}` : "";
  const tableRows = series.map((point) => ({
    date: formatDateLabel(point.t),
    value: `${valueFormat(point.value)}${unitSuffix}`,
  }));

  if (series.length === 0) {
    return (
      <ChartFrame
        title={title}
        summary={`${title}: no data recorded yet.`}
        isEmpty
        emptyLabel={emptyLabel}
        className={className}
      />
    );
  }

  const values = series.map((point) => point.value);
  const valueExtent = extent(values) ?? [0, 1];
  const [lowValue, highValue] = valueExtent;

  let yDomain: [number, number];
  if (variant === "diverging") {
    const magnitude = Math.max(Math.abs(lowValue), Math.abs(highValue), 1e-6);
    const bound = niceUpperBound(magnitude);
    yDomain = [-bound, bound];
  } else if (yBaseline === "extent" && lowValue !== highValue) {
    const padding = (highValue - lowValue) * 0.15;
    yDomain = [lowValue - padding, highValue + padding];
  } else if (lowValue === highValue) {
    // All-equal series (including a single point): a zero-width domain would
    // collapse the plot, so open a symmetric window around the value.
    const magnitude = Math.abs(lowValue) || 1;
    yDomain =
      yBaseline === "zero" && lowValue >= 0
        ? [0, niceUpperBound(magnitude)]
        : [lowValue - magnitude * 0.5, lowValue + magnitude * 0.5];
  } else {
    yDomain = [Math.min(0, lowValue), niceUpperBound(highValue)];
  }

  const plotWidth = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const plotHeight = Math.max(1, height);
  const svgHeight = plotHeight + PAD_TOP + AXIS_HEIGHT;

  const timeExtent = extent(series.map((point) => point.t)) ?? [0, 1];
  const x = linearScale(timeExtent, [PAD_LEFT, PAD_LEFT + plotWidth]);
  const y = linearScale(yDomain, [PAD_TOP + plotHeight, PAD_TOP]);

  const points: Point[] = series.map((point) => ({
    x: x(point.t),
    y: y(point.value),
  }));

  const toneClasses = TONE[tone];
  const negativeClasses = TONE[negativeTone];
  const gridTicks = y.ticks(3);
  const labelIndices = sampleIndices(series.length, plotWidth < 240 ? 3 : 5);
  const showDots = series.length <= DOT_LIMIT;
  const zeroY = y(0);
  const baselineY =
    variant === "diverging" ? zeroY : y(Math.max(yDomain[0], Math.min(0, yDomain[1])));

  // For the diverging fills, clamp the series to one side of zero. This is the
  // same construction as the vibe2text sentiment chart, where the flat runs at
  // the zero line are intentional.
  const positivePoints: Point[] = series.map((point) => ({
    x: x(point.t),
    y: y(Math.max(0, point.value)),
  }));
  const negativePoints: Point[] = series.map((point) => ({
    x: x(point.t),
    y: y(Math.min(0, point.value)),
  }));

  // `linePath` / `areaPath` return "" below two points. Render the element only
  // when there is geometry, so a one-day series does not leave `<path d="">`
  // in the DOM.
  const strokedLine = points.length > 1 ? linePath(points, curve) : "";
  const filledArea = areaPath(points, baselineY, curve);
  const positiveArea = areaPath(positivePoints, zeroY, curve);
  const negativeArea = areaPath(negativePoints, zeroY, curve);

  const total = values.reduce((sum, value) => sum + value, 0);
  const average = total / values.length;
  const summary =
    series.length === 1
      ? `${title}: a single reading of ${valueFormat(values[0])}${unitSuffix} on ${formatDateLabel(series[0].t)}.`
      : `${title}: ${series.length} readings from ${formatDateLabel(series[0].t)} to ` +
        `${formatDateLabel(series[series.length - 1].t)}, ranging ${valueFormat(lowValue)} to ` +
        `${valueFormat(highValue)}${unitSuffix}, averaging ${valueFormat(Math.round(average * 100) / 100)}${unitSuffix}.`;

  return (
    <ChartFrame
      title={title}
      summary={summary}
      caption={
        series.length === 1
          ? "1 day"
          : `${valueFormat(lowValue)}–${valueFormat(highValue)}${unitSuffix}`
      }
      columns={TABLE_COLUMNS}
      rows={tableRows}
      className={className}
    >
      <div ref={containerRef} className="w-full">
        <svg
          width={width}
          height={svgHeight}
          viewBox={`0 0 ${width} ${svgHeight}`}
          aria-hidden="true"
          className="overflow-visible"
        >
          {gridTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD_LEFT}
                x2={PAD_LEFT + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-bg-border"
                strokeWidth={1}
              />
              <text
                x={PAD_LEFT - 5}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={9}
                className="fill-text-faint tabular-nums"
              >
                {valueFormat(tick)}
              </text>
            </g>
          ))}

          {variant === "diverging" ? (
            <>
              {positiveArea ? <path d={positiveArea} className={toneClasses.fillSoft} /> : null}
              {negativeArea ? <path d={negativeArea} className={negativeClasses.fillSoft} /> : null}
              <line
                x1={PAD_LEFT}
                x2={PAD_LEFT + plotWidth}
                y1={zeroY}
                y2={zeroY}
                className="stroke-line-strong"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            </>
          ) : variant === "area" && filledArea ? (
            <path d={filledArea} className={toneClasses.fillSoft} />
          ) : null}

          {strokedLine ? (
            <path
              d={strokedLine}
              fill="none"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={toneClasses.stroke}
            />
          ) : null}

          {(showDots || points.length === 1) &&
            points.map((point, index) => (
              <circle
                key={`dot-${index}`}
                cx={point.x}
                cy={point.y}
                r={points.length === 1 ? 3.5 : 2}
                className={toneClasses.fill}
              >
                <title>
                  {`${formatDateLabel(series[index].t)}: ${valueFormat(series[index].value)}${unitSuffix}`}
                </title>
              </circle>
            ))}

          {labelIndices.map((index) => {
            const anchor =
              series.length === 1
                ? "middle"
                : index === 0
                  ? "start"
                  : index === series.length - 1
                    ? "end"
                    : "middle";
            return (
              <text
                key={`x-${index}`}
                x={x(series[index].t)}
                y={PAD_TOP + plotHeight + 12}
                textAnchor={anchor}
                fontSize={9}
                className="fill-text-faint"
              >
                {formatDateLabel(series[index].t)}
              </text>
            );
          })}
        </svg>
      </div>
    </ChartFrame>
  );
}
