import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { listen } from "@tauri-apps/api/event";
import { Download, FileText } from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { getMissionJournal, getMissionJournalPath } from "@/lib/tauri";

// FIX 1 (E7 polish) — Journal headers come off disk as `## <unix-millis> — <kind>`
// (the Rust journal writer emits raw unix-millis to keep the file format dumb).
// Convert those to a human-readable local-time timestamp before rendering.
// Pure-JS post-processing keeps the on-disk file unchanged for downstream
// markdown consumers — a future Rust-side format change is tracked in backlog.
function prettifyTimestamps(markdown: string): string {
  // Match `## <13-digit unix millis> — <kind>` headers. Headers with
  // non-numeric content (e.g. a user-typed `## 1234`) are left untouched.
  return markdown.replace(
    /^## (\d{13}) — (.+)$/gm,
    (_match, millisStr: string, kind: string) => {
      const date = new Date(Number(millisStr));
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, "0");
      const dd = String(date.getDate()).padStart(2, "0");
      const hh = String(date.getHours()).padStart(2, "0");
      const mi = String(date.getMinutes()).padStart(2, "0");
      const ss = String(date.getSeconds()).padStart(2, "0");
      return `## ${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} — ${kind}`;
    },
  );
}

// E7-UI — Journal tab body. The journal itself is an append-only markdown
// file on disk (`~/.packetade/missions/F-<shortId>_<mission_id>.md`,
// owned by `core::mission_journal`). This component:
//
//   1. Loads the raw markdown via `get_mission_journal` on mount.
//   2. Subscribes to `mission-planner:journal-appended:<missionId>`
//      (fired by the E7-HOOKS slice when new entries land) and re-fetches
//      the whole file. Full re-fetch is fine for v1 — the file is small
//      and append-only; E10 can switch to incremental reads if journals
//      grow long enough that this becomes a bottleneck.
//   3. Exposes an Export button that surfaces the on-disk path so the
//      user can open the file in any markdown viewer. A future
//      "Reveal in OS Finder" command can replace the alert here.
//
// The component owns its own listener lifecycle so the
// `missionPlannerStore.installListeners` plumbing doesn't need to know
// about journal events — keeps the journal feature self-contained.

interface JournalTabProps {
  missionId: string;
}

export function JournalTab({ missionId }: JournalTabProps): JSX.Element {
  const [markdown, setMarkdown] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // FIX 1 — pre-process unix-millis headers into readable local timestamps.
  // Memoize so we don't re-walk the markdown on every render; the regex only
  // re-runs when the on-disk content changes (i.e. after a refetch).
  const prettified = useMemo(() => prettifyTimestamps(markdown), [markdown]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    async function load() {
      try {
        const md = await getMissionJournal(missionId);
        if (!cancelled) {
          setMarkdown(md);
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
    listen(`mission-planner:journal-appended:${missionId}`, () => {
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
  }, [missionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 text-xs text-text-muted">
        Loading journal…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center flex-1 text-xs text-accent-red">
        Failed to load journal: {error}
      </div>
    );
  }

  if (markdown.trim().length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 text-text-muted">
        <FileText size={24} />
        <span className="text-xs">No journal entries yet</span>
        <span className="text-[10px] max-w-md text-center">
          Once the planner starts working on this mission, every tool call,
          wake trigger, user message, and system note will appear here in
          chronological order.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line-soft">
        <span className="text-[11px] text-text-muted">
          Mission journal — append-only record of every planner action.
        </span>
        <button
          onClick={() => void handleExport(missionId)}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-text-secondary border border-bg-border rounded hover:bg-bg-hover hover:text-text-primary transition-colors"
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

// V1 export: resolve the journal file path via the Rust binding and show
// it to the user. A follow-up slice (E7-INTEGRATE / E10) can replace this
// with a real "reveal in OS finder" Tauri command — the public surface
// here is stable enough that the swap is one-line.
//
// FIX 2 — also copy the path to the clipboard so the user can paste it
// straight into a terminal / Finder / Explorer address bar. The inner
// try/catch swallows clipboard-permission failures (some webview contexts
// reject `writeText` silently) and falls back to the path-only alert.
async function handleExport(missionId: string): Promise<void> {
  try {
    const path = await getMissionJournalPath(missionId);
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
