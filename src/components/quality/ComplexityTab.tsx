import { useMemo, useState } from "react";
import { Check, Copy, Search } from "lucide-react";
import type { CodeQualityReport } from "./codeQualityUtils";
import { getComplexityLabel } from "./codeQualityUtils";

interface ComplexityTabProps {
  report: CodeQualityReport;
  /** Optional filter string lifted to the modal so it can be cleared via
   *  the global Esc / Ctrl+F shortcuts. Falls back to local state. */
  filter?: string;
  onFilterChange?: (next: string) => void;
}

export function ComplexityTab({ report, filter: filterProp, onFilterChange }: ComplexityTabProps) {
  const [localFilter, setLocalFilter] = useState("");
  const filter = filterProp ?? localFilter;
  const setFilter = onFilterChange ?? setLocalFilter;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return report.top_complex_files;
    return report.top_complex_files.filter((f) => f.path.toLowerCase().includes(q));
  }, [filter, report.top_complex_files]);

  const maxComplexity = report.top_complex_files.length > 0 ? report.top_complex_files[0].complexity : 1;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-xs font-semibold text-text-primary">
          Average Complexity: {report.avg_complexity.toFixed(1)}
        </h3>
        <p className="text-[10px] text-text-muted mt-0.5">
          {getComplexityLabel(report.avg_complexity)} — based on branches, loops, and conditional logic per file
        </p>
      </div>

      {report.top_complex_files.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[11px] text-text-secondary font-medium">
              Most Complex Files
              {filter && (
                <span className="ml-1.5 text-text-muted font-normal">
                  ({filtered.length} of {report.top_complex_files.length})
                </span>
              )}
            </h4>
            <div className="relative">
              <Search size={10} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter paths…"
                data-quality-filter
                className="bg-bg-primary border border-bg-border rounded pl-5 pr-2 py-1 text-[10px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue w-44"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            {filtered.map((f) => (
              <ComplexFileRow key={f.path} path={f.path} lines={f.lines} complexity={f.complexity} maxComplexity={maxComplexity} />
            ))}
            {filtered.length === 0 && (
              <p className="text-[10px] text-text-muted py-2 text-center">No files match "{filter}".</p>
            )}
          </div>
        </div>
      )}

      {report.top_complex_files.length === 0 && (
        <p className="text-[10px] text-text-muted py-4 text-center">No complexity data available</p>
      )}
    </div>
  );
}

function ComplexFileRow({
  path,
  lines,
  complexity,
  maxComplexity,
}: {
  path: string;
  lines: number;
  complexity: number;
  maxComplexity: number;
}) {
  const [copied, setCopied] = useState(false);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard unavailable — show no feedback rather than alert spam.
    }
  };

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={copyPath}
          title="Copy path"
          className="text-[10px] text-text-secondary truncate flex-1 font-mono text-left hover:text-accent-blue transition-colors group flex items-center gap-1 min-w-0"
        >
          <span className="truncate">{path}</span>
          {copied ? (
            <Check size={9} className="text-accent-green flex-shrink-0" />
          ) : (
            <Copy size={9} className="text-text-muted opacity-0 group-hover:opacity-100 flex-shrink-0" />
          )}
        </button>
        <span className="text-[10px] text-text-muted flex-shrink-0">{complexity} &middot; {lines} lines</span>
      </div>
      <div className="h-1.5 bg-bg-secondary rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${(complexity / maxComplexity) * 100}%`,
            backgroundColor: complexity > 30 ? "#f85149" : complexity > 15 ? "#f0b400" : "#58a6ff",
          }}
        />
      </div>
    </div>
  );
}
