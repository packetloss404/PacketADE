import { useState } from "react";
import { Clipboard, ShieldQuestion, Trash2 } from "lucide-react";
import { useProvenanceAuditStore } from "@/stores/provenanceAuditStore";

export function TrustProvenanceCard() {
  const entries = useProvenanceAuditStore((state) => state.entries);
  const settings = useProvenanceAuditStore((state) => state.settings);
  const setRetentionDays = useProvenanceAuditStore(
    (state) => state.setRetentionDays,
  );
  const setShowSourceChips = useProvenanceAuditStore(
    (state) => state.setShowSourceChips,
  );
  const clear = useProvenanceAuditStore((state) => state.clear);
  const exportJson = useProvenanceAuditStore((state) => state.exportJson);
  const [notice, setNotice] = useState<string | null>(null);

  const copyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportJson());
      setNotice("Redacted trust audit copied.");
    } catch (error) {
      setNotice(`Could not copy audit: ${String(error)}`);
    }
  };

  return (
    <div
      className="rounded-lg border border-bg-border bg-bg-secondary p-4"
      data-dictation="off"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <ShieldQuestion size={12} className="text-accent-blue" />
          Trust & Provenance
        </h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void copyExport()}
            className="rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-accent-blue"
            title="Copy redacted audit export"
          >
            <Clipboard size={11} />
          </button>
          <button
            type="button"
            onClick={clear}
            className="rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-accent-red"
            title="Clear local trust audit"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      <p className="mb-3 text-[10px] leading-relaxed text-text-muted">
        External evidence never grants authority. Risky follow-on actions use
        the existing approval boundary, and this bounded local audit stores
        decision metadata—not transcript or tool output.
      </p>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="text-[10px] text-text-secondary">
          Retention
          <select
            value={settings.retentionDays}
            onChange={(event) =>
              setRetentionDays(event.target.value === "30" ? 30 : 7)
            }
            className="mt-1 w-full rounded border border-bg-border bg-bg-primary px-2 py-1 text-[10px] text-text-primary"
          >
            <option value={7}>7 days / 200 events</option>
            <option value={30}>30 days / 200 events</option>
          </select>
        </label>
        <div className="flex items-end justify-between rounded border border-bg-border bg-bg-primary px-2 py-1.5">
          <span className="text-[10px] text-text-secondary">Source chips</span>
          <button
            type="button"
            onClick={() => setShowSourceChips(!settings.showSourceChips)}
            aria-pressed={settings.showSourceChips}
            className={`relative h-4 w-8 rounded-full ${
              settings.showSourceChips ? "bg-accent-green" : "bg-bg-border"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                settings.showSourceChips ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </div>

      <div className="space-y-1">
        {entries.length === 0 ? (
          <p className="rounded bg-bg-primary px-2 py-2 text-[10px] text-text-muted">
            No trust decisions recorded yet.
          </p>
        ) : (
          entries
            .slice(-10)
            .reverse()
            .map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-2 rounded border border-bg-border bg-bg-primary px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-secondary">
                  {entry.action}
                  {entry.target ? ` · ${entry.target}` : ""}
                </span>
                <span className="shrink-0 text-[9px] text-text-muted">
                  {entry.sourceChain.length > 0
                    ? `${entry.sourceChain.length} source`
                    : "direct"}
                </span>
                <span
                  className={`shrink-0 text-[9px] ${
                    entry.decision.includes("denied") ||
                    entry.decision === "cancelled"
                      ? "text-accent-red"
                      : entry.decision === "prompted"
                        ? "text-accent-amber"
                        : "text-accent-green"
                  }`}
                >
                  {entry.decision.replaceAll("_", " ")}
                </span>
              </div>
            ))
        )}
      </div>
      {notice && <p className="mt-2 text-[9px] text-text-muted">{notice}</p>}
    </div>
  );
}
