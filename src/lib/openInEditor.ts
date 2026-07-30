/**
 * D5 — the ONE production entry point for "open this file in the editor".
 *
 * Audit finding P1-7: `editorStore.openFile` had no production caller, so the
 * whole 480px Editor shell was unreachable. Two real callers now route through
 * here — the clickable-path context menu's "Open in editor" and the Inspector
 * Files tab's row click (finding P1-5) — and both land in the surface-scoped
 * `RightDock` Editor panel.
 *
 * Remote (SSH) callers are refused: the editor reads and writes the LOCAL
 * filesystem, so opening a remote path would silently edit an unrelated local
 * file. Call sites keep the affordance visible-but-disabled per D3.
 */
import { useAppStore } from "@/stores/appStore";
import { useEditorStore } from "@/stores/editorStore";
import { useRightDockStore, type DockSurface } from "@/stores/rightDockStore";
import { resolveProjectPath } from "@/lib/resolveProjectPath";

/**
 * Which surface's dock owns the click. Workspace tiles dock into the Workspace
 * surface; everything else (Agents chat, Inspector) docks into Agents.
 */
export function activeDockSurface(): DockSurface {
  return useAppStore.getState().activeView === "workspace" ? "workspace" : "agents";
}

export interface OpenInEditorOptions {
  /** Project root used to resolve relative paths and scope the FS command. */
  projectPath: string;
  /** D3: refuse remote paths outright. */
  remote?: boolean;
  /** Override the surface whose dock should reveal the Editor panel. */
  surface?: DockSurface;
}

/**
 * Open `path` in the lightweight editor and reveal the Editor dock panel.
 * Returns the buffer id, or `null` when the request was refused (remote).
 */
export function openInEditor(
  path: string,
  { projectPath, remote = false, surface }: OpenInEditorOptions,
): string | null {
  if (remote) return null;
  const absolute = resolveProjectPath(projectPath, path);
  const id = useEditorStore.getState().openFile(absolute, projectPath);
  useRightDockStore.getState().openPanel(surface ?? activeDockSurface(), "editor");
  return id;
}
