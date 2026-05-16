import { useEffect, useRef, useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";

interface CliCatalogHeaderProps {
  installedCount: number;
  /** The currently selected CLI catalog entry, or null if nothing selected. */
  selectedEntry: { id: string; name: string; binary: string } | null;
  /** Whether the most recent rescan is currently in progress. */
  isRescanning: boolean;
  /** Called when the user clicks Rescan. */
  onRescan: () => void | Promise<void>;
  /** Called when the user clicks Test. Returns the test result string for inline rendering. */
  onTest: () => Promise<{ ok: boolean; output: string }>;
}

interface TestOutput {
  ok: boolean;
  text: string;
}

const OUTPUT_CLEAR_MS = 8000;

export function CliCatalogHeader({
  installedCount,
  selectedEntry,
  isRescanning,
  onRescan,
  onTest,
}: CliCatalogHeaderProps) {
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<TestOutput | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const cancelClearTimer = () => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelClearTimer();
    };
  }, []);

  // Clear stale output when the user switches to a different CLI so the
  // previous selection's version/path text isn't visually attached to
  // the new one.
  const selectedId = selectedEntry?.id ?? null;
  useEffect(() => {
    cancelClearTimer();
    setOutput(null);
  }, [selectedId]);

  const scheduleClear = () => {
    cancelClearTimer();
    clearTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setOutput(null);
      clearTimerRef.current = null;
    }, OUTPUT_CLEAR_MS);
  };

  const handleTest = async () => {
    if (!selectedEntry || busy) return;
    cancelClearTimer();
    setOutput(null);
    setBusy(true);
    try {
      const result = await onTest();
      if (!mountedRef.current) return;
      setOutput({ ok: result.ok, text: result.output });
      scheduleClear();
    } catch (e) {
      if (!mountedRef.current) return;
      setOutput({ ok: false, text: e instanceof Error ? e.message : String(e) });
      scheduleClear();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleRescan = () => {
    if (isRescanning) return;
    void onRescan();
  };

  const testDisabled = !selectedEntry || busy;
  const testLabel = busy
    ? "Testing…"
    : selectedEntry
      ? `Test [${selectedEntry.name}]`
      : "Test";

  return (
    <div className="flex flex-col gap-1 mb-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-primary">Local CLI</span>
          <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded bg-bg-elevated">
            {installedCount} installed
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testDisabled}
            title={!selectedEntry ? "Pick a CLI first" : undefined}
            className="px-2 py-1 text-[10px] rounded border border-bg-border bg-bg-secondary hover:bg-bg-elevated text-text-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {testLabel}
          </button>
          <button
            type="button"
            onClick={handleRescan}
            disabled={isRescanning}
            className="px-2 py-1 text-[10px] rounded border border-bg-border bg-bg-secondary hover:bg-bg-elevated text-text-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
          >
            <RotateCcw size={11} className={isRescanning ? "animate-spin" : undefined} />
            <span>{isRescanning ? "Rescanning…" : "Rescan"}</span>
          </button>
        </div>
      </div>

      <p className="text-[10px] text-text-muted">
        Detected by scanning your PATH. Pick the CLI you want generations to flow through.
      </p>

      {output && (
        <pre className="mt-2 px-3 py-2 text-[10px] bg-bg-primary border border-bg-border rounded font-mono text-text-secondary whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
          <span className={output.ok ? "text-accent-green" : "text-accent-red"}>
            {output.ok ? (
              <Check size={10} className="inline-block mr-1 -mt-0.5" />
            ) : (
              <X size={10} className="inline-block mr-1 -mt-0.5" />
            )}
          </span>
          {output.text}
        </pre>
      )}
    </div>
  );
}
