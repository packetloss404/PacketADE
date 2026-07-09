import type { AppView } from "@/stores/appStore";

/**
 * Ctrl+Shift+<number> view-switch map, keyed by the SHIFTED character the
 * browser reports (e.g. Shift+1 → "!"). Extracted from App.tsx so the mapping
 * is unit-testable in isolation.
 *
 * Tile program (P5-S1): `"!"` (Ctrl+Shift+1) was remapped from the retired
 * `"agents"` CoreView to `"workspace"` — the single-surface home. The Agents
 * tab is reachable only through the one-release redirect shim, never a hotkey.
 *
 * Keyboard-layout caveat: the shifted glyph for the number row varies by
 * layout; this pre-existing caveat is inherited unchanged from the original
 * in-App map.
 */
export const VIEW_HOTKEY_MAP: Record<string, AppView> = {
  "!": "workspace", // Shift+1 — remapped from "agents" after CoreView retirement
  "@": "flights", // Shift+2
  "#": "issues", // Shift+3
  "$": "history", // Shift+4
  "%": "tools", // Shift+5
};
