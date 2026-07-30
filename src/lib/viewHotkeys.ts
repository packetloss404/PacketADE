import type { AppView } from "@/stores/appStore";

/**
 * Ctrl+Shift+<number> view-switch map, keyed by the SHIFTED character the
 * browser reports (e.g. Shift+1 → "!"). Extracted from App.tsx so the mapping
 * is unit-testable in isolation.
 *
 * WA1 restores `"!"` (Ctrl+Shift+1) as the Agents shortcut. Workspace keeps
 * its mnemonic Ctrl+Shift+W shortcut in App.tsx, avoiding a disruptive
 * renumbering of the other long-standing view chords.
 *
 * Keyboard-layout caveat: the shifted glyph for the number row varies by
 * layout; this pre-existing caveat is inherited unchanged from the original
 * in-App map.
 */
export const VIEW_HOTKEY_MAP: Record<string, AppView> = {
  "!": "agents", // Shift+1
  "@": "flights", // Shift+2
  "#": "issues", // Shift+3
  $: "history", // Shift+4
  "%": "tools", // Shift+5
};
