/**
 * The ONE front door for creating a Workspace.
 *
 * Creation used to run as two parallel flows that never mentioned each other:
 *
 *   A. `WorkspaceCreationModal` — required a name, at least one CLI session and
 *      a non-empty project path.
 *   B. an "instant" path (Ctrl+N, the Fleet sidebar buttons) that created a
 *      zero-pane workspace hard-named "New Session" with whatever happened to
 *      be in `layoutStore.projectPath` — including the empty string flow A
 *      explicitly blocks.
 *
 * Flow B is genuinely useful (one keystroke to a scratch workspace), so it
 * survives — but it now shares this module's rules with flow A: one noun
 * ("Workspace"), unique auto-names, and no path-less workspaces. The hard
 * invariant is enforced one level lower, in `workspaceStore.createWorkspace`,
 * so no caller can bypass it; this module is what keeps the instant path from
 * ever hitting that error in the first place.
 */
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** Base name for auto-named workspaces. The noun is "Workspace" everywhere. */
export const WORKSPACE_NAME_BASE = "Workspace";

/**
 * First unused `"Workspace"`, `"Workspace 2"`, `"Workspace 3"`… name.
 *
 * Repeated Ctrl+N used to fill the fleet list and the tab strip with rows all
 * reading "New Session", distinguishable only by a relative timestamp.
 */
export function nextWorkspaceName(
  existingNames: Iterable<string>,
  base: string = WORKSPACE_NAME_BASE,
): string {
  const taken = new Set<string>();
  for (const name of existingNames) taken.add(name.trim());
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/**
 * OS folder picker. Imported lazily so the Tauri dialog plugin is only pulled
 * in when a path actually has to be chosen (and so unit tests that never take
 * this branch need no plugin mock).
 */
async function pickProjectFolder(title: string): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title });
    if (!selected || typeof selected !== "string") return null;
    return selected;
  } catch {
    // No dialog available (browser/test harness) — the caller treats this the
    // same as "user cancelled" and creates nothing.
    return null;
  }
}

/**
 * The instant path: create a workspace with no form.
 *
 * When no project path is known the user gets the OS folder picker first —
 * the same fork the Toolbar folder button already offers — instead of a
 * silently broken path-less workspace. Returns the new workspace id, or `null`
 * when the user cancelled the folder picker.
 */
export async function createInstantWorkspace(): Promise<string | null> {
  let path = (useLayoutStore.getState().projectPath ?? "").trim();
  if (!path) {
    const picked = await pickProjectFolder("Choose a project folder for the new workspace");
    if (!picked) return null;
    path = picked;
  }

  const store = useWorkspaceStore.getState();
  const name = nextWorkspaceName((store.workspaces ?? []).map((w) => w.name));
  const id = store.createWorkspace(name, [], path);

  // Keep the fallback project path in sync when we had to ask for one. Done
  // AFTER creation so `layoutStore.setProjectPath`'s write-through targets the
  // workspace we just created (which already carries this exact path) rather
  // than rebinding whatever was previously active.
  useLayoutStore.getState().setProjectPath(path);
  useAppStore.getState().setActiveView("workspace");
  return id;
}

/**
 * The considered path: ask the Workspace surface to open the full New
 * Workspace form (templates, models, remote, bypass-perms).
 *
 * Used by the global entry points — the Toolbar "+ New" menu and the Ctrl+K
 * palette — which are not mounted inside `WorkspaceView` and must not each
 * render their own modal instance.
 */
export function openWorkspaceCreationModal(): void {
  useAppStore.getState().setActiveView("workspace");
  useWorkspaceStore.getState().requestWorkspaceCreation();
}
