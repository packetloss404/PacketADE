import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { listen } from "@tauri-apps/api/event";
import { Download, FileText } from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { getFlightJournalPath, getFlightJournalTail, type FlightJournalRead } from "@/lib/tauri";

const JOURNAL_TAIL_BYTES = 128 * 1024;

// FIX 1 (E7 polish) — Journal headers come off disk as `## <unix-millis> — <kind>`
// (the Rust journal writer emits raw unix-millis to keep the file format dumb).
// Convert those to a human-readable local-time timestamp before rendering.
// Pure-JS post-processing keeps the on-disk file unchanged for downstream
// markdown consumers — a future Rust-side format change is tracked in backlog.
function prettifyTimestamps(markdown: string): string {
  // Match `## <13-digit unix millis> — <kind>` headers. Headers with
  // non-numeric content (e.g. a user-typed `## 1234`) are left untouched.
  return markdown.replace(/^## (\d{13}) — (.+)$/gm, (_match, millisStr: string, kind: string) => {
    const date = new Date(Number(millisStr));
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `## ${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} — ${kind}`;
  });
}

// E7-UI — Journal tab body. The journal itself is an append-only markdown
// file on disk (`~/.packetade/missions/F-<tail>_<flight_id>.md`,
// owned by `core::flight_journal`). This component:
//
//   1. Loads the latest raw markdown slice via `get_flight_journal_tail` on mount.
//   2. Subscribes to `flight-planner:journal-appended:<flightId>`
//      (fired by the E7-HOOKS slice when new entries land) and re-fetches
//      a bounded latest tail. This keeps long-running flights responsive:
//      the full append-only archive remains on disk and the UI says when
//      it is showing a tail view.
//   3. Exposes an Export button that surfaces the on-disk path so the
//      user can open the file in any markdown viewer. A future
//      "Reveal in OS Finder" command can replace the alert here.
//
// The component owns its own listener lifecycle so the
// `flightPlannerStore.installListeners` plumbing doesn't need to know
// about journal events — keeps the journal feature self-contained.

interface JournalTabProps {
  flightId: string;
}

export function JournalTab({ flightId }: JournalTabProps): JSX.Element {
  const [journal, setJournal] = useState<FlightJournalRead>({
    markdown: "",
    totalBytes: 0,
    returnedBytes: 0,
    truncated: false,
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const markdown = journal.markdown;

  // FIX 1 — pre-process unix-millis headers into readable local timestamps.
  // Memoize so we don't re-walk the markdown on every render; the regex only
  // re-runs when the on-disk content changes (i.e. after a refetch).
  const prettified = useMemo(() => prettifyTimestamps(markdown), [markdown]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    async function load() {
      try {
        const nextJournal = await getFlightJournalTail(flightId, JOURNAL_TAIL_BYTES);
        if (!cancelled) {
          setJournal(nextJournal);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      }
    }

    void load();

    // Subscribe to journal-appended events — re-fetch the whole journal
    // when new entries land. The handler races against the unmount path,
    // so it always guards on `cancelled` before mutating state.
    listen(`flight-planner:journal-appended:${flightId}`, () => {
      if (!cancelled) {
        void load();
      }
    }).then((fn) => {
      if (cancelled) {
        // If the component unmounted before `listen()` resolved, tear
        // the listener down immediately so we don't leak it.
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    };
  }, [flightId]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-text-muted">
        Loading journal…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-accent-red">
        Failed to load journal: {error}
      </div>
    );
  }

  if (markdown.trim().length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-text-muted">
        <FileText size={24} />
        <span className="text-xs">No journal entries yet</span>
        <span className="max-w-md text-center text-[10px]">
          Once the planner starts working on this flight, every tool call, wake trigger, user
          message, and system note will appear here in chronological order.
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft px-3 py-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[11px] text-text-muted">
            Flight journal — append-only record of every planner action.
          </span>
          <span
            className={
              journal.truncated ? "text-[10px] text-accent-amber" : "text-[10px] text-text-faint"
            }
          >
            {journal.truncated
              ? `Showing latest ${formatBytes(journal.returnedBytes)} of ${formatBytes(journal.totalBytes)}. Export opens the full journal.`
              : `Showing full journal (${formatBytes(journal.totalBytes)}).`}
          </span>
        </div>
        <button
          onClick={() => void handleExport(flightId)}
          className="inline-flex items-center gap-1 rounded border border-bg-border px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          title="Reveal journal file path"
        >
          <Download size={11} />
          Export
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        <MarkdownRenderer content={prettified} />
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  }
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

// V1 export: resolve the journal file path via the Rust binding and show
// it to the user. A follow-up slice (E7-INTEGRATE / E10) can replace this
// with a real "reveal in OS finder" Tauri command — the public surface
// here is stable enough that the swap is one-line.
//
// FIX 2 — also copy the path to the clipboard so the user can paste it
// straight into a terminal / Finder / Explorer address bar. The inner
// try/catch swallows clipboard-permission failures (some webview contexts
// reject `writeText` silently) and falls back to the path-only alert.
async function handleExport(flightId: string): Promise<void> {
  try {
    const path = await getFlightJournalPath(flightId);
    try {
      await navigator.clipboard.writeText(path);
      alert(`Journal saved to:\n\n${path}\n\n(Path copied to clipboard.)`);
    } catch {
      alert(`Journal saved to:\n\n${path}`);
    }
  } catch (err) {
    alert(`Failed to resolve journal path: ${String(err)}`);
  }
}
