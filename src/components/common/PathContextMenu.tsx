import { useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-shell";
import {
  FileText,
  Copy,
  AtSign,
  FolderOpen,
} from "lucide-react";
import { REMOTE_UNSUPPORTED_TOOLTIP } from "@/lib/remoteConversation";

export interface PathContextMenuProps {
  /** Viewport x coordinate (px) for the menu anchor */
  x: number;
  /** Viewport y coordinate (px) for the menu anchor */
  y: number;
  /** Absolute or repo-relative path captured from the right-click target */
  path: string;
  /** Optional 1-based line number parsed from `path:line` */
  line?: number;
  /** Close the menu (parent should null-out its menu state) */
  onClose: () => void;
  /** Inject `@path` into the agent input via the parent */
  onAttach: (path: string) => void;
  /** D3 / P0-4: the surrounding conversation runs on an SSH host, so this path
   * exists on the REMOTE filesystem. "Open in editor" / "Show in Explorer"
   * would act on an unrelated local path — they stay visible but disabled. */
  remote?: boolean;
}

/**
 * Returns the parent directory of a given path. Handles both POSIX `/`
 * and Windows `\` separators. Falls back to the path itself if no
 * separator is present.
 */
function parentDir(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return p;
  return p.slice(0, idx);
}

/**
 * Fixed-position context menu for clickable file/path references rendered by
 * the assistant. Closes on outside click and Escape. Pure presentation —
 * the host wrapper handles detection and positioning.
 */
export function PathContextMenu({
  x,
  y,
  path,
  line,
  onClose,
  onAttach,
  remote = false,
}: PathContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer outside-click binding by a tick so the right-click that opened
    // the menu doesn't immediately close it.
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);
    document.addEventListener("keydown", handleKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const handleOpen = async () => {
    // v1: ask the OS to open the file with its default app. A future
    // iteration can route this through an in-app editor / FileExplorer
    // without changing this component's API.
    try {
      await open(path);
    } catch (err) {
      console.warn("[PathContextMenu] open(file) failed:", err);
      alert(`Cannot open: ${err}`);
    }
    onClose();
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(path);
    } catch (err) {
      console.warn("[PathContextMenu] clipboard.writeText failed:", err);
    }
    onClose();
  };

  const handleAttach = () => {
    onAttach(path);
    onClose();
  };

  const handleShowInExplorer = async () => {
    try {
      await open(parentDir(path));
    } catch (err) {
      console.warn("[PathContextMenu] open(parentDir) failed:", err);
    }
    onClose();
  };

  // Clamp to viewport so the menu never spills offscreen.
  const MENU_WIDTH = 220;
  const MENU_HEIGHT = 160;
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
  const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 8);

  const itemClass =
    "w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors text-left";
  const disabledItemClass =
    "w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-primary text-left opacity-40 cursor-not-allowed";

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Path actions"
      className="fixed z-[1000] min-w-[220px] bg-bg-secondary border border-bg-border rounded-md shadow-lg py-1"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="px-3 py-1 text-[10px] text-text-muted truncate border-b border-bg-border mb-1"
        title={line ? `${path}:${line}` : path}
      >
        {line ? `${path}:${line}` : path}
      </div>

      <button
        type="button"
        className={remote ? disabledItemClass : itemClass}
        disabled={remote}
        aria-disabled={remote}
        title={remote ? REMOTE_UNSUPPORTED_TOOLTIP : undefined}
        onClick={handleOpen}
      >
        <FileText size={12} className="text-accent-green shrink-0" />
        <span>Open in editor</span>
      </button>
      <button type="button" className={itemClass} onClick={handleCopy}>
        <Copy size={12} className="text-text-secondary shrink-0" />
        <span>Copy path</span>
      </button>
      <button type="button" className={itemClass} onClick={handleAttach}>
        <AtSign size={12} className="text-text-secondary shrink-0" />
        <span>Attach as @mention</span>
      </button>
      <button
        type="button"
        className={remote ? disabledItemClass : itemClass}
        disabled={remote}
        aria-disabled={remote}
        title={remote ? REMOTE_UNSUPPORTED_TOOLTIP : undefined}
        onClick={handleShowInExplorer}
      >
        <FolderOpen size={12} className="text-text-secondary shrink-0" />
        <span>Show in Explorer</span>
      </button>
    </div>
  );
}

export default PathContextMenu;
