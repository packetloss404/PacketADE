import { ChartFrame, type ChartTableColumn } from "./ChartFrame";
import { RAMP_STEPS, TONE, rampIndex, type ChartTone } from "./tokens";

/**
 * Row-major cell grid with a five-step intensity ramp.
 *
 * Serves both heatmaps in the dictation analytics set — the 7x24 day/hour
 * activity matrix and the GitHub-style 53x7 yearly contribution grid — because
 * they are the same shape with different labelling.
 *
 * Rendered as HTML boxes rather than SVG `<rect>`s. The vibe2text originals use
 * `d3.scaleLinear().range([bgHex, accentHex])` to interpolate a fill colour per
 * cell, which cannot be reproduced here: PacketBench's theme colours are
 * `color-mix()` custom properties that change with the light/dark theme, so
 * there is no hex pair to interpolate between. Bucketing into fixed opacity
 * classes gives a ramp that tracks both themes, and gets native `title`
 * tooltips and flexbox layout for free.
 */

export interface HeatmapGridProps {
  title: string;
  /** Row-major values. `rows[r][c]`; ragged rows are padded with zero. */
  rows: readonly (readonly number[])[];
  /** One label per row, e.g. `["Sun", ..., "Sat"]`. */
  rowLabels: readonly string[];
  /**
   * Sparse column labels aligned to column indices; `null` renders no label.
   * e.g. `["12a", null, ..., "6a", null, ...]`.
   */
  columnLabels?: readonly (string | null)[];
  /** Cell edge length in px. Default 12. */
  cellSize?: number;
  cellGap?: number;
  tone?: ChartTone;
  /**
   * Position label for one cell, without the value — e.g. `"Tue 14:00"`.
   * The value and unit are appended by the primitive for tooltips.
   */
  cellLabel?: (rowIndex: number, columnIndex: number) => string;
  /** Noun for the accessible summary, e.g. "transcriptions". */
  unit?: string;
  /** Render the intensity legend under the grid. Default true. */
  showLegend?: boolean;
  emptyLabel?: string;
  className?: string;
}

const TABLE_COLUMNS: ChartTableColumn[] = [
  { key: "cell", label: "Cell" },
  { key: "value", label: "Count", numeric: true },
];

export function HeatmapGrid({
  title,
  rows,
  rowLabels,
  columnLabels,
  cellSize = 12,
  cellGap = 2,
  tone = "green",
  cellLabel,
  unit = "entries",
  showLegend = true,
  emptyLabel = "No activity recorded yet",
  className,
}: HeatmapGridProps) {
  const columnCount = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const cells: { row: number; column: number; value: number }[] = [];
  let max = 0;
  let total = 0;
  let activeCells = 0;

  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < columnCount; c += 1) {
      const raw = rows[r][c];
      const value = Number.isFinite(raw) ? raw : 0;
      cells.push({ row: r, column: c, value });
      if (value > max) max = value;
      if (value > 0) {
        total += value;
        activeCells += 1;
      }
    }
  }

  const labelFor =
    cellLabel ??
    ((rowIndex: number, columnIndex: number) =>
      `${rowLabels[rowIndex] ?? `Row ${rowIndex + 1}`} ${columnLabels?.[columnIndex] ?? `#${columnIndex + 1}`}`);
  const describe = (rowIndex: number, columnIndex: number, value: number) =>
    `${labelFor(rowIndex, columnIndex)} — ${value} ${unit}`;

  if (columnCount === 0 || total === 0) {
    return (
      <ChartFrame
        title={title}
        summary={`${title}: no activity recorded yet.`}
        isEmpty
        emptyLabel={emptyLabel}
        className={className}
      />
    );
  }

  const busiest = cells.reduce((best, cell) => (cell.value > best.value ? cell : best), cells[0]);
  const summary =
    `${title}: ${total} ${unit} across ${activeCells} of ${cells.length} slots. ` +
    `Busiest is ${describe(busiest.row, busiest.column, busiest.value)}.`;

  const ramp = TONE[tone].ramp;
  const tableRows = cells
    .filter((cell) => cell.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((cell) => ({
      cell: labelFor(cell.row, cell.column),
      value: String(cell.value),
    }));

  return (
    <ChartFrame
      title={title}
      summary={summary}
      caption={`peak ${max}`}
      columns={TABLE_COLUMNS}
      rows={tableRows}
      className={className}
    >
      <div className="overflow-x-auto" aria-hidden="true">
        <div className="inline-flex flex-col" style={{ gap: cellGap }}>
          {rows.map((_, rowIndex) => (
            <div key={rowIndex} className="flex items-center" style={{ gap: cellGap }}>
              <span
                className="shrink-0 pr-1 text-right text-[9px] leading-none text-text-faint"
                style={{ width: 26 }}
              >
                {rowLabels[rowIndex] ?? ""}
              </span>
              {Array.from({ length: columnCount }, (_unused, columnIndex) => {
                const raw = rows[rowIndex][columnIndex];
                const value = Number.isFinite(raw) ? raw : 0;
                const step = rampIndex(value, max);
                return (
                  <div
                    key={columnIndex}
                    className={`shrink-0 rounded-[2px] ${ramp[step]}`}
                    style={{ width: cellSize, height: cellSize }}
                    title={describe(rowIndex, columnIndex, value)}
                  />
                );
              })}
            </div>
          ))}

          {columnLabels?.length ? (
            <div className="flex items-center" style={{ gap: cellGap }}>
              <span className="shrink-0 pr-1" style={{ width: 26 }} />
              {Array.from({ length: columnCount }, (_unused, columnIndex) => (
                <span
                  key={columnIndex}
                  className="shrink-0 text-center text-[9px] leading-none text-text-faint"
                  style={{ width: cellSize }}
                >
                  {columnLabels[columnIndex] ?? ""}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {showLegend ? (
        <div
          className="mt-2 flex items-center gap-1 text-[10px] text-text-faint"
          aria-hidden="true"
        >
          <span>Less</span>
          {Array.from({ length: RAMP_STEPS }, (_unused, step) => (
            <span
              key={step}
              className={`inline-block rounded-[2px] ${ramp[step]}`}
              style={{ width: 9, height: 9 }}
            />
          ))}
          <span>More</span>
        </div>
      ) : null}
    </ChartFrame>
  );
}
