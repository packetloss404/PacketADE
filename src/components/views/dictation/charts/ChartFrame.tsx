import type { ReactNode } from "react";

/**
 * Shared panel chrome for every dictation analytics chart.
 *
 * Centralising it here means the three concerns that are easy to forget once
 * per chart — the empty state, the accessible text alternative, and the
 * `<details>` data-table fallback — are handled once and cannot drift between
 * twenty panels.
 *
 * Accessibility contract: the SVG or grid a caller passes as `children` is
 * decorative and must be marked `aria-hidden`. The real content for assistive
 * technology is `summary` (announced on the figure) plus the `table` rows,
 * which live in a keyboard-reachable `<details>` element rather than in an
 * `sr-only` block — sighted keyboard users get the numbers too.
 */

export interface ChartTableColumn {
  key: string;
  label: string;
  /** Right-align numeric columns. */
  numeric?: boolean;
}

export interface ChartFrameProps {
  title: string;
  /**
   * One-sentence description of what the chart shows, including the headline
   * numbers. Announced as the figure's accessible name.
   */
  summary: string;
  /** Optional secondary line under the title (units, range, subtotal). */
  caption?: string;
  /** Shown instead of `children` when `isEmpty` is true. */
  emptyLabel?: string;
  isEmpty?: boolean;
  /** Column definitions for the data-table fallback. */
  columns?: ChartTableColumn[];
  /** Row values keyed by `ChartTableColumn.key`. */
  rows?: Record<string, string>[];
  /** Cap on rendered fallback rows; the rest are summarised. */
  maxTableRows?: number;
  children?: ReactNode;
  className?: string;
}

export function ChartFrame({
  title,
  summary,
  caption,
  emptyLabel = "No data yet",
  isEmpty = false,
  columns,
  rows,
  maxTableRows = 60,
  children,
  className = "",
}: ChartFrameProps) {
  const hasTable = !isEmpty && !!columns?.length && !!rows?.length;
  const shownRows = hasTable ? rows.slice(0, maxTableRows) : [];
  const hiddenRowCount = hasTable ? rows.length - shownRows.length : 0;

  return (
    <figure
      className={`rounded-lg border border-bg-border bg-bg-secondary p-4 ${className}`}
      role="group"
      aria-label={`${title}. ${summary}`}
    >
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
          {title}
        </span>
        {caption ? (
          <span className="text-[10px] tabular-nums text-text-faint">{caption}</span>
        ) : null}
      </figcaption>

      {isEmpty ? (
        <p className="mt-3 text-[11px] text-text-faint">{emptyLabel}</p>
      ) : (
        <>
          <div className="mt-3">{children}</div>
          {hasTable ? (
            <details className="group mt-2">
              <summary className="cursor-pointer list-none rounded text-[10px] text-text-faint outline-none hover:text-text-muted focus-visible:ring-1 focus-visible:ring-accent-line">
                <span className="group-open:hidden">Show data table</span>
                <span className="hidden group-open:inline">Hide data table</span>
              </summary>
              <div className="mt-2 max-h-48 overflow-auto rounded border border-bg-border">
                <table className="w-full border-collapse text-[10px]">
                  <caption className="sr-only">{`${title}. ${summary}`}</caption>
                  <thead className="sticky top-0 bg-bg-tertiary">
                    <tr>
                      {columns.map((column) => (
                        <th
                          key={column.key}
                          scope="col"
                          className={`px-2 py-1 font-medium text-text-muted ${
                            column.numeric ? "text-right" : "text-left"
                          }`}
                        >
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map((row, index) => (
                      <tr key={index} className="border-t border-bg-border">
                        {columns.map((column) => (
                          <td
                            key={column.key}
                            className={`px-2 py-1 text-text-secondary ${
                              column.numeric ? "text-right tabular-nums" : "text-left"
                            }`}
                          >
                            {row[column.key] ?? ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {hiddenRowCount > 0 ? (
                <p className="mt-1 text-[10px] text-text-faint">
                  {`${hiddenRowCount} earlier row${hiddenRowCount === 1 ? "" : "s"} not shown.`}
                </p>
              ) : null}
            </details>
          ) : null}
        </>
      )}
    </figure>
  );
}
