import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { sweepAutoArchive } from "@/stores/agentConversationPersistence";
import { createInstantWorkspace } from "@/lib/workspaceCreation";

/**
 * Returns true when a keydown originated inside an editable element, so a
 * global shortcut can yield the keystroke to typing. Shared by the new-work
 * shortcut and transcript view-mode cycler.
 */
function isEditableTarget(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (target?.isContentEditable ?? false);
}

/**
 * App-shell agent shortcuts and maintenance:
 *
 *   - **Ctrl/Cmd+N** — context-aware new work: Agents clears the active
 *     conversation and exposes its launch composer; other surfaces retain the
 *     existing new-Workspace behavior until WA2 changes Workspace defaults.
 *   - **Ctrl/Cmd+Shift+O** — cycle the global transcript view mode
 *     (Summary → Normal → Verbose). Moved off Ctrl+Shift+V: that chord is
 *     push-to-talk dictation (App's handleKeyDown), and both firing on one chord
 *     meant the transcript view mode flipped every time dictation started.
 *     Ctrl+Shift+O is otherwise unbound. The typing guard keeps the cycler from
 *     firing inside a composer.
 *   - **sweepAutoArchive** — runs on mount and hourly thereafter at the App
 *     shell so archive maintenance does not depend on the Agents route being
 *     open.
 */
export function useAgentTabHoists(): void {
  // Ctrl/Cmd+N → new GUI agent in Agents, otherwise a new Workspace.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isShortcut = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "n";
      if (!isShortcut) return;
      if (isEditableTarget(e)) return;
      e.preventDefault();
      if (useAppStore.getState().activeView === "agents") {
        useAgentTaskStore.getState().selectConversation(null);
        return;
      }
      // The shared instant-creation front door: uniquely auto-named
      // ("Workspace", "Workspace 2", …), never path-less (it falls into the OS
      // folder picker when no project path is known), and it activates both the
      // new workspace and the Workspace surface. Its empty zero-state hosts the
      // CLI-only AddSessionPicker.
      void createInstantWorkspace();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Ctrl/Cmd+Shift+O → cycle transcript view mode (moved off Shift+V, which is
  // push-to-talk dictation, to end the two-handlers-one-chord collision).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isShortcut = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o";
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
