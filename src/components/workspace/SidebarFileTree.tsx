/**
 * The FILES subtree inside an expanded Fleet-sidebar workspace row.
 *
 * A lazy, indented directory tree rooted at the workspace's project path.
 * Folders load their children on first expand and cache them for the life of
 * the mount, so scrolling the fleet list never re-hits the filesystem — this
 * matters on DrvFs (`/mnt/d`), where a recursive scan is genuinely slow.
 *
 * Clicking a file opens it as a viewer tile in the workspace grid (the same
 * `kind: "file"` pane the "+ → File Viewer" row creates), so a file can sit
 * beside a running agent. Directory listing is the existing sandboxed
 * `list_directory` command, which already scopes reads to the workspace root
 * and filters hidden/sensitive entries — this component adds no new FS reach.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, RotateCw } from "lucide-react";
import { listDirectory } from "@/lib/tauri";
import { Spinner } from "@/components/ui/Spinner";

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  extension: string | null;
}

interface SidebarFileTreeProps {
  /** Workspace root — both the tree root and the sandbox scope for reads. */
  projectPath: string;
  /** Absolute paths currently open as viewer tiles, for the active highlight. */
  openPaths: ReadonlySet<string>;
  onOpenFile: (absolutePath: string) => void;
}

/** Directories first, then files; each group alphabetical, case-insensitive. */
function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function SidebarFileTree({ projectPath, openPaths, onOpenFile }: SidebarFileTreeProps) {
  // dirPath -> its listing. Absence means "never loaded".
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(
    (dirPath: string, force = false) => {
      if (!force && (children[dirPath] || loading[dirPath])) return;
      setLoading((prev) => ({ ...prev, [dirPath]: true }));
      listDirectory(dirPath, projectPath)
        .then((entries) => {
          setChildren((prev) => ({ ...prev, [dirPath]: sortEntries(entries) }));
          setErrors((prev) => {
            if (!prev[dirPath]) return prev;
            const next = { ...prev };
            delete next[dirPath];
            return next;
          });
        })
        .catch((err: unknown) => {
          setErrors((prev) => ({
            ...prev,
            [dirPath]: err instanceof Error ? err.message : String(err),
          }));
        })
        .finally(() => setLoading((prev) => ({ ...prev, [dirPath]: false })));
    },
    [children, loading, projectPath],
  );

  // The root loads eagerly — the row is only rendered once the user has already
  // expanded FILES, so there is no hidden background scan.
  useEffect(() => {
    if (!projectPath) return;
    load(projectPath);
    // Intentionally keyed on the path alone: `load` closes over the caches and
    // would otherwise re-fire on every listing that lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const toggleDir = (dirPath: string) => {
    const next = !expanded[dirPath];
    setExpanded((prev) => ({ ...prev, [dirPath]: next }));
    if (next) load(dirPath);
  };

  const renderLevel = (dirPath: string, depth: number) => {
    const entries = children[dirPath];
    const error = errors[dirPath];

    if (error) {
      return (
        <div
          className="py-1 pr-2 text-meta text-accent-red"
          style={{ paddingLeft: 12 + depth * 10 }}
          title={error}
        >
          <span className="line-clamp-2 break-words">{error}</span>
        </div>
      );
    }

    if (!entries) {
      return loading[dirPath] ? (
        <div
          className="flex items-center gap-1.5 py-1 text-meta text-text-muted"
          style={{ paddingLeft: 12 + depth * 10 }}
        >
          <Spinner size={9} />
          Loading…
        </div>
      ) : null;
    }

    if (entries.length === 0) {
      return (
        <div
          className="py-1 text-meta italic text-text-muted"
          style={{ paddingLeft: 12 + depth * 10 }}
        >
          empty
        </div>
      );
    }

    return entries.map((entry) => {
      const isOpen = expanded[entry.path];
      const isActive = !entry.is_dir && openPaths.has(entry.path);
      return (
        <div key={entry.path}>
          <button
            type="button"
            onClick={() => (entry.is_dir ? toggleDir(entry.path) : onOpenFile(entry.path))}
            title={entry.path}
            className={`group/file flex w-full items-center gap-1 py-[3px] pr-2 text-left text-meta transition-colors hover:bg-bg-hover ${
              isActive ? "text-accent-green" : "text-text-secondary"
            }`}
            style={{ paddingLeft: 12 + depth * 10 }}
          >
            {entry.is_dir ? (
              isOpen ? (
                <ChevronDown size={9} className="shrink-0 text-text-muted" />
              ) : (
                <ChevronRight size={9} className="shrink-0 text-text-muted" />
              )
            ) : (
              <span className="w-[9px] shrink-0" />
            )}
            {entry.is_dir ? (
              <Folder size={10} className="shrink-0 text-accent-amber" />
            ) : (
              <File size={10} className="shrink-0 text-text-muted" />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          {entry.is_dir && isOpen && renderLevel(entry.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="pb-1">
      <div className="flex items-center gap-1 py-[3px] pl-3 pr-1">
        <span className="text-meta font-semibold uppercase tracking-wide text-text-muted">
          Files
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            // Refresh drops every cached listing under this root so a newly
            // created file shows up without collapsing the whole row.
            setChildren({});
            setErrors({});
            load(projectPath, true);
            for (const dir of Object.keys(expanded)) {
              if (expanded[dir]) load(dir, true);
            }
          }}
          className="rounded p-0.5 text-text-muted transition-colors hover:text-text-secondary"
          title="Refresh file list"
          aria-label="Refresh file list"
        >
          <RotateCw size={9} />
        </button>
      </div>
      {renderLevel(projectPath, 0)}
    </div>
  );
}
