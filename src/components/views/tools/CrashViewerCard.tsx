import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Trash2, Eye, X } from "lucide-react";
import { listCrashes, readCrash, deleteCrash, type CrashEntry } from "@/lib/tauri";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";

export function CrashViewerCard() {
  const [crashes, setCrashes] = useState<CrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ path: string; content: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setCrashes(await listCrashes());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleView(path: string) {
    try {
      const content = await readCrash(path);
      setViewing({ path, content });
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(path: string) {
    try {
      await deleteCrash(path);
      await refresh();
      if (viewing?.path === path) setViewing(null);
    } catch (e) {
      setError(String(e));
    }
  }

  function formatTimestamp(ts: string): string {
    const n = Number(ts);
    if (!Number.isFinite(n)) return ts;
    return new Date(n * 1000).toLocaleString();
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          <AlertTriangle size={12} className="text-accent-red" />
          Crash Reports
        </h3>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 text-[10px] text-accent-red bg-accent-red/10 border border-accent-red/30 rounded px-2 py-1">
          {error}
        </div>
      )}

      {crashes.length === 0 ? (
        <p className="text-[10px] text-text-muted text-center py-4">
          No crash reports. The app is healthy.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {crashes.map((c) => (
            <div
              key={c.path}
              className="flex items-start gap-2 bg-bg-primary border border-bg-border rounded-lg p-3"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-medium text-text-primary">
                  {formatTimestamp(c.timestamp)}
                </div>
                <p className="text-[10px] text-text-muted truncate">{c.summary}</p>
              </div>
              <button
                onClick={() => handleView(c.path)}
                className="p-1 text-text-muted hover:text-accent-green transition-colors flex-shrink-0"
                title="View"
              >
                <Eye size={11} />
              </button>
              <button
                onClick={() => setPendingDelete(c.path)}
                className="p-1 text-text-muted hover:text-accent-red transition-colors flex-shrink-0"
                title="Delete crash report"
                aria-label={`Delete crash report ${c.path}`}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {viewing && (
        <div className="mt-4 bg-bg-primary border border-bg-border rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-text-muted truncate">{viewing.path}</span>
            <button
              onClick={() => setViewing(null)}
              className="p-1 text-text-muted hover:text-text-primary"
            >
              <X size={11} />
            </button>
          </div>
          <pre className="text-[10px] text-text-secondary whitespace-pre-wrap max-h-64 overflow-y-auto font-mono">
            {viewing.content}
          </pre>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete crash report?"
          entityName={pendingDelete}
          description="is deleted from disk. Copy anything you still need out of it first."
          onConfirm={() => {
            void handleDelete(pendingDelete);
            setPendingDelete(null);
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
