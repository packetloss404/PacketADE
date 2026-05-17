import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Folder,
  FileText,
  ChevronUp,
  RotateCw,
  Server,
  AlertCircle,
} from "lucide-react";
import { listDirectory } from "@/lib/tauri";

/**
 * Read-only file tree pane for the agent inspector.
 *
 * Renders the conversation's project directory as a navigable list of folders
 * and files. Folder click descends, file click fires `onSelectFile?(path)` and
 * copies the absolute path to the clipboard. SSH conversations show a static
 * "not supported" message because `listDirectory` operates on the local FS.
 */

interface AgentFilePaneProps {
  conversationId: string;
  projectPath: string;
  sshTarget?: { host: string; user: string; remotePath: string } | null;
  /** Optional callback fired when a file row is clicked. */
  onSelectFile?: (absolutePath: string) => void;
}

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  extension: string | null;
}

const MAX_ENTRIES = 500;

/** Strip a trailing slash/backslash unless the path is a root marker. */
function trimTrailingSeparator(p: string): string {
  if (p.length <= 1) return p;
  const last = p[p.length - 1];
  if (last === "/" || last === "\\") {
    // Keep `C:\` and `/` as-is; only strip when there is more than the root.
    if (/^[A-Za-z]:[\\/]$/.test(p) || p === "/") return p;
    return p.slice(0, -1);
  }
  return p;
}

/** Compute the parent directory of an absolute path. Returns null at root. */
function parentOf(p: string): string | null {
  const trimmed = trimTrailingSeparator(p);
  // Windows drive root (e.g. "C:\" or "C:")
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed)) return null;
  // POSIX root
  if (trimmed === "/" || trimmed === "") return null;

  // Find last separator (either kind).
  const lastBack = trimmed.lastIndexOf("\\");
  const lastFwd = trimmed.lastIndexOf("/");
  const idx = Math.max(lastBack, lastFwd);
  if (idx <= 0) {
    // Path like "C:\\foo" → parent is "C:\\"; path like "/foo" → parent is "/".
    if (/^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 2) + "\\";
    return "/";
  }
  // Preserve drive root form: "C:\\foo" → "C:\\".
  const parent = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) return parent + "\\";
  return parent || "/";
}

/** Split an absolute path into clickable breadcrumb segments. */
function breadcrumbSegments(
  p: string,
): { label: string; path: string }[] {
  const trimmed = trimTrailingSeparator(p);
  const segments: { label: string; path: string }[] = [];

  // Detect Windows drive root.
  const driveMatch = trimmed.match(/^([A-Za-z]:)([\\/].*)?$/);
  if (driveMatch) {
    const drive = driveMatch[1];
    segments.push({ label: drive + "\\", path: drive + "\\" });
    const rest = driveMatch[2] ?? "";
    const parts = rest.split(/[\\/]+/).filter(Boolean);
    let acc = drive + "\\";
    for (const part of parts) {
      acc = acc.endsWith("\\") ? acc + part : acc + "\\" + part;
      segments.push({ label: part, path: acc });
    }
    return segments;
  }

  // POSIX-style.
  segments.push({ label: "/", path: "/" });
  const parts = trimmed.split("/").filter(Boolean);
  let acc = "";
  for (const part of parts) {
    acc = acc + "/" + part;
    segments.push({ label: part, path: acc });
  }
  return segments;
}

/** Humanize a byte count: 1.2 KB, 3.4 MB, etc. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

export function AgentFilePane({
  conversationId,
  projectPath,
  sshTarget,
  onSelectFile,
}: AgentFilePaneProps) {
  const [currentPath, setCurrentPath] = useState<string>(projectPath);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState<number>(0);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

  // Reset to the conversation's project root when the conversation changes.
  useEffect(() => {
    setCurrentPath(projectPath);
    setHighlightedIdx(0);
  }, [conversationId, projectPath]);

  const loadDir = useCallback(
    async (dir: string) => {
      const reqId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const all = await listDirectory(dir, projectPath);
        if (requestIdRef.current !== reqId) return;
        const folders = all
          .filter((e) => e.is_dir)
          .sort((a, b) => a.name.localeCompare(b.name));
        const files = all
          .filter((e) => !e.is_dir)
          .sort((a, b) => a.name.localeCompare(b.name));
        const combined = [...folders, ...files];
        const remaining = Math.max(0, combined.length - MAX_ENTRIES);
        setEntries(combined.slice(0, MAX_ENTRIES));
        setTruncated(remaining);
        setHighlightedIdx(0);
      } catch (e) {
        if (requestIdRef.current !== reqId) return;
        setEntries([]);
        setTruncated(0);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (requestIdRef.current === reqId) setLoading(false);
      }
    },
    [projectPath],
  );

  useEffect(() => {
    void loadDir(currentPath);
  }, [currentPath, loadDir]);

  // Cleanup the toast timer on unmount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const segments = useMemo(
    () => breadcrumbSegments(currentPath),
    [currentPath],
  );

  const goUp = useCallback(() => {
    const parent = parentOf(currentPath);
    if (parent && parent !== currentPath) setCurrentPath(parent);
  }, [currentPath]);

  const refresh = useCallback(() => {
    void loadDir(currentPath);
  }, [currentPath, loadDir]);

  const showCopiedToast = useCallback((p: string) => {
    setCopiedPath(p);
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedPath(null);
      copyTimerRef.current = null;
    }, 1400);
  }, []);

  const openEntry = useCallback(
    (entry: DirEntry) => {
      if (entry.is_dir) {
        setCurrentPath(entry.path);
        return;
      }
      onSelectFile?.(entry.path);
      // Best-effort clipboard write — failure (e.g. no permission) is silent.
      try {
        void navigator.clipboard?.writeText(entry.path);
      } catch {
        /* noop */
      }
      showCopiedToast(entry.path);
    },
    [onSelectFile, showCopiedToast],
  );

  // Keep the highlighted row visible when arrow-keying.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(
      `[data-file-row-idx="${highlightedIdx}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [highlightedIdx]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIdx((i) => Math.min(entries.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        const target = entries[highlightedIdx];
        if (target?.is_dir) {
          e.preventDefault();
          openEntry(target);
        } else if (target) {
          e.preventDefault();
          openEntry(target);
        }
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        goUp();
      }
    },
    [entries, highlightedIdx, openEntry, goUp],
  );

  // SSH conversations are short-circuited — `listDirectory` only sees the
  // local filesystem, so the remote tree would be misleading. Branch lives
  // after all hooks so render order stays stable across SSH/local switches.
  if (sshTarget) {
    return (
      <div className="flex flex-col h-full bg-bg-primary items-center justify-center px-4 text-center">
        <Server size={20} className="text-text-muted mb-2" />
        <span className="text-[11px] text-text-secondary max-w-xs">
          File browsing on SSH targets is not yet supported.
        </span>
        <span className="text-[10px] text-text-muted mt-1 max-w-xs">
          Open the worktree on your local machine to browse it.
        </span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full bg-bg-primary outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Header: breadcrumb + actions */}
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-secondary border-b border-bg-border shrink-0">
        <button
          type="button"
          onClick={goUp}
          disabled={parentOf(currentPath) == null}
          title="Parent directory (Backspace)"
          className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronUp size={12} />
        </button>
        <button
          type="button"
          onClick={refresh}
          title="Refresh"
          className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors"
        >
          <RotateCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
        <div className="flex-1 min-w-0 overflow-x-auto">
          <div className="flex items-center gap-0.5 text-[11px] font-mono whitespace-nowrap">
            {segments.map((seg, i) => {
              const isLast = i === segments.length - 1;
              return (
                <span key={seg.path} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => setCurrentPath(seg.path)}
                    className={`px-1 py-0.5 rounded hover:bg-bg-hover transition-colors ${
                      isLast
                        ? "text-text-primary"
                        : "text-text-secondary hover:text-text-primary"
                    }`}
                    title={seg.path}
                  >
                    {seg.label}
                  </button>
                  {!isLast && (
                    <span className="text-text-muted">/</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {/* Body */}
      <div ref={listRef} className="flex-1 overflow-y-auto relative">
        {error && (
          <div className="flex items-start gap-2 m-3 px-2 py-2 bg-accent-red/10 border border-accent-red/30 rounded text-[11px] text-accent-red">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">Failed to list directory</div>
              <div className="text-[10px] text-accent-red/80 break-all mt-0.5">
                {error}
              </div>
            </div>
          </div>
        )}

        {!error && !loading && entries.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <span className="text-[11px] text-text-muted">Empty directory</span>
          </div>
        )}

        {!error && entries.length > 0 && (
          <div className="py-1">
            {entries.map((entry, idx) => {
              const Icon = entry.is_dir ? Folder : FileText;
              const isHighlighted = idx === highlightedIdx;
              return (
                <button
                  key={entry.path}
                  type="button"
                  data-file-row-idx={idx}
                  onClick={() => {
                    setHighlightedIdx(idx);
                    openEntry(entry);
                  }}
                  onMouseEnter={() => setHighlightedIdx(idx)}
                  className={`w-full flex items-center gap-2 px-3 py-1 text-left text-[11px] transition-colors ${
                    isHighlighted
                      ? "bg-bg-hover text-text-primary"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                  title={entry.path}
                >
                  <Icon
                    size={12}
                    className={
                      entry.is_dir ? "text-accent-blue" : "text-text-muted"
                    }
                  />
                  <span className="flex-1 min-w-0 truncate font-mono">
                    {entry.name}
                  </span>
                  {!entry.is_dir && (
                    <span className="text-[10px] text-text-muted shrink-0 tabular-nums">
                      {formatSize(entry.size)}
                    </span>
                  )}
                </button>
              );
            })}
            {truncated > 0 && (
              <div className="px-3 py-1.5 text-[10px] text-text-muted italic">
                + {truncated} more (showing first {MAX_ENTRIES})
              </div>
            )}
          </div>
        )}

        {/* Copy toast */}
        {copiedPath && (
          <div
            className="absolute bottom-3 left-1/2 -translate-x-1/2 px-2 py-1 bg-accent-green/15 border border-accent-green/40 rounded text-[10px] text-accent-green shadow-md pointer-events-none"
            role="status"
          >
            copied!
          </div>
        )}
      </div>
    </div>
  );
}
