import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useDictationStore } from "@/stores/dictationStore";
import { resolveViewHotkey } from "@/lib/viewHotkeys";
import { isEditableTarget, isTerminalTarget } from "@/lib/keyboardTarget";

/**
 * App-shell global keyboard shortcuts. Hoisted out of `App.tsx` so the
 * focus guards are unit-testable in isolation.
 *
 *   - **Ctrl+K** — toggle the command palette. UX-08: skipped entirely when
 *     focus sits in a terminal or any editable control, because Ctrl+K is
 *     readline's kill-line — a user killing a line at their shell was getting
 *     the palette dropped over the terminal. The one exception is the palette
 *     itself: while it is open, Ctrl+K still closes it (focus is in the
 *     palette's own search input, and a toggle that can't untoggle is worse).
 *   - **Escape** — closes the command palette (modal dismiss, always honored),
 *     otherwise cancels an in-flight dictation recording. The dictation branch
 *     yields inside a terminal: Escape there belongs to vim/the shell.
 *   - **Ctrl+Shift+&lt;chord&gt;** — route switching from the D4 route registry,
 *     matched on the PHYSICAL key so the chords survive non-US layouts. Yields
 *     inside a terminal only; text fields don't bind Ctrl+Shift chords, so
 *     navigation stays available while typing in a composer.
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Layering (matches `Modal`): an inner surface that already consumed
      // this keypress — xterm, an open dropdown, the palette's own list
      // handler — marks it handled. One keypress unwinds one layer.
      if (e.defaultPrevented) return;

      const app = useAppStore.getState();

      // Ctrl+K toggles the command palette — unless the keystroke belongs to a
      // terminal or a text field. While the palette is open it always closes.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        if (!app.commandPaletteOpen && isEditableTarget(e)) return;
        e.preventDefault();
        app.setCommandPaletteOpen(!app.commandPaletteOpen);
        return;
      }

      // Escape closes the command palette. Deliberately unguarded: the palette
      // owns focus (its search input) whenever it is open, and dismissing a
      // modal with Escape must always work.
      if (e.key === "Escape" && app.commandPaletteOpen) {
        e.preventDefault();
        app.setCommandPaletteOpen(false);
        return;
      }

      // Escape cancels an active dictation recording. Skipped inside a
      // terminal, where Escape is the CLI's (vim insert-mode exit, readline
      // meta prefix, TUI back). Editable controls keep the cancel: they are
      // the usual dictation target and Escape has no competing meaning there.
      if (e.key === "Escape" && !isTerminalTarget(e)) {
        const ds = useDictationStore.getState();
        if (ds.isStarting || ds.isRecording) {
          e.preventDefault();
          void ds.cancelRecording();
          return;
        }
      }

      // Ctrl+Shift+<chord> view switching. D4: every binding is declared once
      // in the route registry and matched on the PHYSICAL key, so the chords
      // work on non-US keyboard layouts.
      if (e.ctrlKey && e.shiftKey) {
        // Terminals own their keystrokes; text fields don't bind Ctrl+Shift
        // chords, so navigation stays available while typing in a composer.
        if (isTerminalTarget(e)) return;
        const target = resolveViewHotkey(e);
        if (target) {
          e.preventDefault();
          app.setActiveView(target);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
