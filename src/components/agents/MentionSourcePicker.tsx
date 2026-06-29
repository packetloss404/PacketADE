import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Folder, Globe, GitBranch } from "lucide-react";
import { FileMentionPopover } from "./FileMentionPopover";
import { InputPopover, type InputPopoverItem } from "./InputPopover";
import { MentionTypeBar } from "./MentionTypeBar";
import { getGitBranch } from "@/lib/tauri";
import {
  formatMentionInsert,
  type MentionSource,
} from "@/types/mention";

interface MentionSourcePickerProps {
  visible: boolean;
  projectPath: string;
  /** Initial source the picker should open on (defaults to "files"). */
  initialSource?: MentionSource;
  /** Free-text query as typed after the `@` (used by Files/Folders). */
  query: string;
  highlightedIndex: number;
  /**
   * Called when the user picks/commits a mention. The value is the formatted
   * insertion string (e.g. `@src/foo.ts`, `@web:https://...`, `@git:main`).
   */
  onSelect: (insertion: string) => void;
  /** Forwarded to FileMentionPopover and the folder list for keyboard nav. */
  onItemsChange?: (paths: string[]) => void;
}

/**
 * Backend file entry shape (snake_case from Rust). The current
 * `list_project_files` command returns a flat string list, but several
 * neighboring commands return rich entries — we tolerate either here so the
 * folder filter works as soon as the backend exposes `is_dir`.
 */
interface ProjectEntry {
  path: string;
  is_dir?: boolean;
}

/**
 * Wraps the existing file-mention popover with a typed-source bar and adds
 * minimal popover bodies for Folders / Web / Git. The Files source defers
 * entirely to `FileMentionPopover` so existing behavior is preserved.
 */
export function MentionSourcePicker({
  visible,
  projectPath,
  initialSource = "files",
  query,
  highlightedIndex,
  onSelect,
  onItemsChange,
}: MentionSourcePickerProps) {
  const [source, setSource] = useState<MentionSource>(initialSource);

  // Reset to initial source whenever the popover (re)opens.
  useEffect(() => {
    if (visible) setSource(initialSource);
  }, [visible, initialSource]);

  if (!visible) return null;

  return (
    <div className="absolute bottom-full mb-1 left-0 z-50">
      <MentionTypeBar active={source} onChange={setSource} />
      <div className="relative">
        {source === "files" && (
          <FileMentionPopover
            visible
            projectPath={projectPath}
            query={query}
            highlightedIndex={highlightedIndex}
            onSelect={(path) => onSelect(formatMentionInsert("files", path))}
            onItemsChange={onItemsChange}
            floating={false}
            className="rounded-t-none"
          />
        )}
        {source === "folders" && (
          <FolderPopover
            projectPath={projectPath}
            query={query}
            highlightedIndex={highlightedIndex}
            onSelect={(path) => onSelect(formatMentionInsert("folders", path))}
            onItemsChange={onItemsChange}
          />
        )}
        {source === "web" && (
          <WebInputPopover
            onSubmit={(url) => onSelect(formatMentionInsert("web", url))}
          />
        )}
        {source === "git" && (
          <GitBranchPopover
            projectPath={projectPath}
            highlightedIndex={highlightedIndex}
            onSelect={(branch) =>
              onSelect(formatMentionInsert("git", branch))
            }
            onItemsChange={onItemsChange}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

interface FolderPopoverProps {
  projectPath: string;
  query: string;
  highlightedIndex: number;
  onSelect: (path: string) => void;
  onItemsChange?: (paths: string[]) => void;
}

function FolderPopover({
  projectPath,
  query,
  highlightedIndex,
  onSelect,
  onItemsChange,
}: FolderPopoverProps) {
  const [items, setItems] = useState<InputPopoverItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const results = await invoke<ProjectEntry[] | string[]>(
          "list_project_files",
          { projectPath, filter: query, limit: 50 },
        );
        if (cancelled) return;
        const folderPaths = filterFolders(results ?? [], query);
        const mapped: InputPopoverItem[] = folderPaths.map((path) => ({
          key: path,
          label: path,
          icon: <Folder size={12} />,
        }));
        setItems(mapped);
        onItemsChange?.(folderPaths);
      } catch {
        if (!cancelled) {
          setItems([]);
          onItemsChange?.([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [projectPath, query, onItemsChange]);

  return (
    <InputPopover
      visible
      items={items}
      loading={loading}
      highlightedIndex={highlightedIndex}
      onSelect={(item) => onSelect(item.key)}
      emptyLabel="No folders found"
      floating={false}
      className="rounded-t-none"
    />
  );
}

/**
 * Filter a mixed list of `ProjectEntry` or string paths down to folder-only
 * entries. When the backend returns rich entries we use `is_dir`; when it
 * returns the current flat string list we derive folders client-side from the
 * unique directory prefixes of the file paths (so the Folders tab isn't empty).
 */
function filterFolders(
  entries: ProjectEntry[] | string[],
  query: string,
): string[] {
  if (entries.length === 0) return [];
  const first = entries[0];
  if (typeof first === "string") {
    const strs = entries as string[];
    // Honor explicit trailing-slash dirs if the backend ever sends them.
    const explicit = strs.filter((p) => p.endsWith("/"));
    if (explicit.length > 0) return explicit;
    // Otherwise derive every ancestor directory prefix from the file paths.
    const dirs = new Set<string>();
    for (const p of strs) {
      const norm = p.replace(/\\/g, "/");
      const lastSlash = norm.lastIndexOf("/");
      if (lastSlash <= 0) continue;
      const parts = norm.slice(0, lastSlash).split("/");
      let acc = "";
      for (const part of parts) {
        if (!part) continue;
        acc = acc ? `${acc}/${part}` : part;
        dirs.add(`${acc}/`);
      }
    }
    const q = query.toLowerCase();
    return Array.from(dirs)
      .filter((d) => d.toLowerCase().includes(q))
      .sort();
  }
  return (entries as ProjectEntry[])
    .filter((e) => e.is_dir === true)
    .map((e) => e.path);
}

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------

interface WebInputPopoverProps {
  onSubmit: (url: string) => void;
}

function WebInputPopover({ onSubmit }: WebInputPopoverProps) {
  const [url, setUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <div
      className={[
        "min-w-[260px] max-w-[420px]",
        "bg-bg-secondary border border-bg-border rounded rounded-t-none",
        "shadow-xl p-2 flex items-center gap-2",
      ].join(" ")}
    >
      <Globe size={12} className="text-text-secondary flex-shrink-0" />
      <span className="text-[11px] text-text-secondary flex-shrink-0">
        Fetch URL:
      </span>
      <input
        ref={inputRef}
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="https://..."
        className={[
          "flex-1 min-w-0 bg-bg-primary border border-bg-border rounded",
          "px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted",
          "focus:outline-none focus:border-accent-green/50",
        ].join(" ")}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

interface GitBranchPopoverProps {
  projectPath: string;
  highlightedIndex: number;
  onSelect: (branch: string) => void;
  onItemsChange?: (paths: string[]) => void;
}

function GitBranchPopover({
  projectPath,
  highlightedIndex,
  onSelect,
  onItemsChange,
}: GitBranchPopoverProps) {
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const branch = await getGitBranch(projectPath);
        if (cancelled) return;
        const trimmed = (branch ?? "").trim();
        setCurrentBranch(trimmed || null);
        onItemsChange?.(trimmed ? [trimmed] : []);
      } catch {
        if (!cancelled) {
          setCurrentBranch(null);
          onItemsChange?.([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, onItemsChange]);

  // Build the list: current branch first (if known), otherwise empty.
  // `highlightedIndex` is honored so the parent can drive ArrowUp/Down.
  const items: InputPopoverItem[] = currentBranch
    ? [
        {
          key: currentBranch,
          label: currentBranch,
          description: "current",
          icon: <GitBranch size={12} />,
        },
      ]
    : [];

  const submitTyped = () => {
    const trimmed = typed.trim();
    if (!trimmed) return;
    onSelect(trimmed);
  };

  return (
    <div className="flex flex-col">
      <div
        className={[
          "min-w-[260px] max-w-[420px]",
          "bg-bg-secondary border border-bg-border border-b-0 rounded-none",
          "shadow-xl p-2 flex items-center gap-2",
        ].join(" ")}
      >
        <GitBranch size={12} className="text-text-secondary flex-shrink-0" />
        <span className="text-[11px] text-text-secondary flex-shrink-0">
          Branch:
        </span>
        <input
          ref={inputRef}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitTyped();
            }
          }}
          placeholder={currentBranch ?? "branch name"}
          className={[
            "flex-1 min-w-0 bg-bg-primary border border-bg-border rounded",
            "px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted",
            "focus:outline-none focus:border-accent-green/50",
          ].join(" ")}
        />
      </div>
      <InputPopover
        visible
        items={items}
        highlightedIndex={highlightedIndex}
        onSelect={(item) => onSelect(item.key)}
        emptyLabel="Type a branch name and press Enter"
        floating={false}
        className="rounded-t-none"
      />
    </div>
  );
}
