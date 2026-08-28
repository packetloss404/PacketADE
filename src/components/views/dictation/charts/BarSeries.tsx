import { ChartFrame, type ChartTableColumn } from "./ChartFrame";
import { TONE, type ChartTone } from "./tokens";
import { formatCompact } from "./scale";

/**
 * Categorical bars — vertical columns or horizontal rows.
 *
 * This is the primitive for the large majority of the dictation analytics set,
 * because most of those panels are `value / max` proportions rather than
 * charts: hour-of-day distributions, ranked word lists, word-length buckets,
 * per-topic speed. See `dev/dictation-analytics-charting.md` for the full
 * mapping.
 *
 * Geometry is CSS percentage width/height, so there is no scale object, no
 * measurement, and no reflow bug — the bars are correct at every container
 * size including zero. `d3.scaleBand` and `d3.scaleLinear` buy nothing here;
 * flexbox already does band layout.
 */

export interface BarDatum {
  label: string;
  /** `null` renders an explicit "no reading" slot rather than a zero bar. */
  value: number | null;
  /** Optional per-bar tone override, e.g. sentiment-coloured topic rows. */
  tone?: ChartTone;
  /** Optional trailing text shown after the value on horizontal bars. */
  note?: string;
}

export interface BarSeriesProps {
  title: string;
  data: readonly BarDatum[];
  orientation?: "vertical" | "horizontal";
  tone?: ChartTone;
  /**
   * Sparse axis labels for `vertical`, aligned to data indices; `null` renders
   * no label. Ignored for `horizontal`, which labels every row.
   */
  axisLabels?: readonly (string | null)[];
  /** Plot height in px for `vertical`. Default 56. */
  height?: number;
  /** Shared ceiling so sibling panels stay comparable. Defaults to the max. */
  maxValue?: number;
  unit?: string;
  valueFormat?: (value: number) => string;
  /** Show the numeric value at the end of each `horizontal` row. Default true. */
  showValues?: boolean;
  emptyLabel?: string;
  className?: string;
}

const TABLE_COLUMNS: ChartTableColumn[] = [
  { key: "label", label: "Label" },
  { key: "value", label: "Value", numeric: true },
];

export function BarSeries({
  title,
  data,
  orientation = "vertical",
  tone = "green",
  axisLabels,
  height = 56,
  maxValue,
  unit,
  valueFormat = formatCompact,
  showValues = true,
  emptyLabel = "No data yet",
  className,
}: BarSeriesProps) {
  const present = data.filter(
    (datum): datum is BarDatum & { value: number } =>
      datum.value !== null && Number.isFinite(datum.value),
  );
  const unitSuffix = unit ? ` ${unit}` : "";

  if (present.length === 0) {
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

  const observedMax = present.reduce((best, datum) => Math.max(best, datum.value), 0);
  // A ceiling of zero (every reading is zero) would divide by zero; fall back
  // to 1 so every bar renders at its minimum height instead of NaN.
  const requestedMax = maxValue ?? observedMax;
  const ceiling = requestedMax > 0 ? requestedMax : 1;

  const top = present.reduce(
    (best, datum) => (datum.value > best.value ? datum : best),
    present[0],
  );
  const total = present.reduce((sum, datum) => sum + datum.value, 0);
  const summary =
    present.length === 1
      ? `${title}: one reading, ${top.label} at ${valueFormat(top.value)}${unitSuffix}.`
      : `${title}: ${present.length} values totalling ${valueFormat(total)}${unitSuffix}. ` +
        `Highest is ${top.label} at ${valueFormat(top.value)}${unitSuffix}.`;

  const tableRows = present.map((datum) => ({
    label: datum.label,
    value: `${valueFormat(datum.value)}${unitSuffix}`,
  }));

  return (
    <ChartFrame
      title={title}
      summary={summary}
      caption={`max ${valueFormat(top.value)}${unitSuffix}`}
      columns={TABLE_COLUMNS}
      rows={tableRows}
      className={className}
    >
      {orientation === "vertical" ? (
        <div aria-hidden="true">
          <div className="flex items-end gap-[2px]" style={{ height }}>
            {data.map((datum, index) => {
              const classes = TONE[datum.tone ?? tone];
              if (datum.value === null || !Number.isFinite(datum.value)) {
                return (
                  <div
                    key={`${datum.label}-${index}`}
                    className="h-[2px] flex-1 self-end rounded-sm bg-bg-tertiary"
                    title={`${datum.label} — no reading`}
                  />
                );
              }
              const pct = (datum.value / ceiling) * 100;
              return (
                <div
                  key={`${datum.label}-${index}`}
                  className={`flex-1 rounded-t transition-colors ${classes.bg} ${classes.bgHover}`}
                  style={{ height: `${Math.max(2, pct)}%` }}
                  title={`${datum.label} — ${valueFormat(datum.value)}${unitSuffix}`}
                />
              );
            })}
          </div>
          {axisLabels?.length ? (
            <div className="mt-1 flex gap-[2px]">
              {data.map((datum, index) => (
                <span
                  key={`axis-${datum.label}-${index}`}
                  className="flex-1 text-center text-[10px] leading-none text-text-faint"
                >
                  {axisLabels[index] ?? ""}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-1.5" aria-hidden="true">
          {data.map((datum, index) => {
            const classes = TONE[datum.tone ?? tone];
            const value = datum.value;
            const pct = value === null || !Number.isFinite(value) ? 0 : (value / ceiling) * 100;
            return (
              <div key={`${datum.label}-${index}`} className="flex items-center gap-2">
                <span className="w-20 shrink-0 truncate font-mono text-[10px] text-text-secondary">
                  {datum.label}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
                  <div
                    className={`h-full rounded-full transition-all ${classes.bg}`}
                    style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                  />
                </div>
                {showValues ? (
                  <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-text-muted">
                    {value === null || !Number.isFinite(value)
                      ? "—"
                      : `${valueFormat(value)}${datum.note ? ` ${datum.note}` : ""}`}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </ChartFrame>
  );
}
