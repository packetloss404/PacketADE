import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { sweepAutoArchive } from "@/stores/agentConversationPersistence";

/**
 * Returns true when a keydown originated inside an editable element, so a
 * global shortcut can yield the keystroke to typing. Mirrors the guard the
 * retiring AgentsView used for Ctrl+N / Ctrl+Shift+V.
 */
function isEditableTarget(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    (target?.isContentEditable ?? false)
  );
}

/**
 * Tile program (P5-S1): survivors hoisted out of AgentsView so nothing
 * regresses when that view is deleted (P5-S2). Mounted once by the App shell:
 *
 *   - **Ctrl/Cmd+N** — start a new session. In the single-surface world that is
 *     a fresh empty workspace whose zero-state renders the inline
 *     `AddAgentPicker`; we switch to the Workspace surface so it is visible.
 *     Same typing guard as before, so the literal "n" still reaches inputs.
 *   - **Ctrl/Cmd+Shift+V** — cycle the global transcript view mode
 *     (Summary → Normal → Verbose). This is a SEPARATE listener from App's
 *     push-to-talk Ctrl+Shift+V handler; both fire on the chord exactly as they
 *     did while AgentsView was mounted (the push-to-talk handler lives in App's
 *     handleKeyDown and starts recording; this one cycles the transcript mode).
 *     The typing guard keeps the cycler from firing inside a composer.
 *   - **sweepAutoArchive** — runs on mount and hourly thereafter, moved from
 *     AgentsView's mount effect to the App shell so the self-curating archive
 *     keeps sweeping without the Agents tab ever being opened.
 */
export function useAgentTabHoists(): void {
  // Ctrl/Cmd+N → new session (fresh empty workspace + Workspace surface).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isShortcut =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "n";
      if (!isShortcut) return;
      if (isEditableTarget(e)) return;
      e.preventDefault();
      const projectPath = useLayoutStore.getState().projectPath ?? "";
      // createWorkspace auto-activates the new workspace; its empty zero-state
      // hosts the inline AddAgentPicker ("Add your first agent").
      useWorkspaceStore.getState().createWorkspace("New Session", [], projectPath);
      useAppStore.getState().setActiveView("workspace");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Ctrl/Cmd+Shift+V → cycle transcript view mode (coexists with push-to-talk).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isShortcut =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v";
      if (!isShortcut) return;
      if (isEditableTarget(e)) return;
      e.preventDefault();
      useAgentSettingsStore.getState().cycleTranscriptViewMode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Self-curating archive: sweep on mount, then hourly.
  useEffect(() => {
    sweepAutoArchive();
    const interval = window.setInterval(sweepAutoArchive, 60 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);
}
