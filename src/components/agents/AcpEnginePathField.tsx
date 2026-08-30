/**
 * Point PacketBench at a `packetcode` binary it could not find by itself.
 *
 * ## Why this exists
 *
 * The `api-packetcode` row is keyless — the engine holds its own provider
 * credentials — so the *only* thing that can make it unusable is PacketBench
 * failing to locate the engine. Resolution searches, in order: this pinned
 * path, `PACKETBENCH_ACP_ENGINE`, `PATH`, and the documented install
 * directories. That misses a very ordinary case: packetcode's own installers
 * do not put it on `PATH` (`install.ps1` says so outright), and a build from
 * source lands somewhere nothing searches at all.
 *
 * Before this field the remedy was an environment variable. An environment
 * variable is not a UI — a desktop user cannot be asked to set one, the app
 * cannot show what it resolved to, and every other provider's not-ready badge
 * points at Settings. This is that Settings pointer.
 *
 * ## What it promises
 *
 * The backend validates before it writes (absolute, exists, is a file,
 * executable), so a rejected path never becomes the stored setting and can
 * never outrank an engine that was already working. On success the resolved
 * VERSION is shown, because that is the only evidence that the file chosen is
 * really a packetcode engine and not some other program with the right name.
 *
 * Rendered by both the PacketCode engine gate (where a stuck user actually
 * lands) and Settings → Provider Endpoints (where they go looking).
 */
import { useCallback, useEffect, useState } from "react";
import { Check, FolderOpen, Loader2, RotateCcw } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getAcpEnginePath, setAcpEnginePath, type AcpEngineProbe } from "@/lib/tauri";

export interface AcpEnginePathFieldProps {
  /**
   * Called with the probe returned after a successful save or clear, so the
   * host surface can adopt the new verdict instead of waiting for its own
   * next probe. The gate uses this to drop straight through to the route.
   */
  onProbe?: (probe: AcpEngineProbe) => void;
  /** Extra classes on the wrapper. */
  className?: string;
}

/** Best-effort text of a rejected invoke (Tauri rejects with strings). */
function reasonText(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

/**
 * One line describing what the saved path now resolves to.
 *
 * Deliberately reports the probe rather than the save: a path can be a real,
 * executable file and still not be a usable engine, and saying "Saved" over
 * that would be the same over-claim this whole field exists to remove.
 */
function probeSummary(probe: AcpEngineProbe): { tone: "ok" | "warn"; text: string } {
  if (!probe.found) {
    return { tone: "warn", text: "Saved, but no engine could be run from that path." };
  }
  if (probe.compatible) {
    return {
      tone: "ok",
      text: `packetcode ${probe.version ?? "(version not reported)"} is ready.`,
    };
  }
  if (!probe.version?.trim()) {
    return {
      tone: "warn",
      text: "That file ran but did not report a version, so it may not be a packetcode engine.",
    };
  }
  return {
    tone: "warn",
    text: `packetcode ${probe.version} is older than the required ${probe.minimumVersion}.`,
  };
}

export function AcpEnginePathField({ onProbe, className = "" }: AcpEnginePathFieldProps) {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAcpEnginePath()
      .then((path) => {
        if (cancelled) return;
        setSaved(path);
        setDraft(path ?? "");
      })
      .catch((reason) => {
        if (!cancelled) setError(reasonText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = useCallback(
    async (next: string | null) => {
      setBusy(true);
      setError(null);
      setSummary(null);
      try {
        const probe = await setAcpEnginePath(next);
        setSaved(next);
        setDraft(next ?? "");
        setSummary(probeSummary(probe));
        onProbe?.(probe);
      } catch (reason) {
        // Nothing was written — the backend validates before it saves — so the
        // field keeps showing what is still in effect.
        setError(reasonText(reason));
      } finally {
        setBusy(false);
      }
    },
    [onProbe],
  );

  const browse = useCallback(async () => {
    // No extension filter: the engine is `packetcode.exe` on Windows and an
    // extensionless file everywhere else, and a filter would hide the latter.
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      title: "Choose the packetcode engine binary",
    });
    if (typeof picked === "string") {
      setDraft(picked);
      setError(null);
      setSummary(null);
    }
  }, []);

  const trimmed = draft.trim();
  const dirty = trimmed !== (saved ?? "");

  return (
    <div className={className}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor="acp-engine-path" className="text-[11px] text-text-secondary">
          PacketCode engine binary
        </label>
        <span className="text-[10px] text-text-muted">
          {saved ? "Pinned" : "Unset — searching PATH and the install directory"}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          id="acp-engine-path"
          type="text"
          spellCheck={false}
          value={draft}
          disabled={busy}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
            setSummary(null);
          }}
          placeholder="Full path to the packetcode binary"
          className="min-w-0 flex-1 rounded border border-bg-border bg-bg-primary px-2 py-1.5 font-mono text-[11px] text-text-primary placeholder:font-sans placeholder:text-text-muted focus:border-accent-green focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void browse()}
          disabled={busy}
          className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
          title="Browse for the packetcode binary"
        >
          <FolderOpen size={12} />
        </button>
        <button
          type="button"
          onClick={() => void apply(trimmed)}
          disabled={busy || !dirty || !trimmed}
          className="rounded p-1.5 text-accent-green transition-colors hover:bg-accent-green/10 disabled:opacity-40 disabled:hover:bg-transparent"
          title="Use this binary"
        >
          {busy ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> : <Check size={12} />}
        </button>
        <button
          type="button"
          onClick={() => void apply(null)}
          disabled={busy || (!saved && !trimmed)}
          className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
          title="Clear the pinned path and go back to searching PATH"
        >
          <RotateCcw size={12} />
        </button>
      </div>
      <div className="mt-1.5 rounded border border-bg-border bg-bg-primary px-3 py-2 text-[10px] text-text-muted">
        PacketCode is a separate program with its own provider credentials — PacketBench never
        holds an API key for it. Pin the binary here when it is not on{" "}
        <span className="text-text-secondary">PATH</span>, which is the normal outcome of both its
        own installer and a build from source. Takes precedence over{" "}
        <span className="text-text-secondary">PACKETBENCH_ACP_ENGINE</span>; clearing it goes back
        to searching <span className="text-text-secondary">PATH</span> and the default install
        directory. Applies to new conversations.
      </div>
      {summary && (
        <div
          className={`mt-1 text-[10px] ${summary.tone === "ok" ? "text-accent-green" : "text-accent-amber"}`}
        >
          {summary.text}
        </div>
      )}
      {error && <div className="mt-1 text-[10px] text-accent-red">{error}</div>}
    </div>
  );
}
