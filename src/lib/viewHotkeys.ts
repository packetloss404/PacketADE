import type { AppView } from "@/stores/appStore";
import { hotkeyRoutes, resolveViewHotkey } from "@/lib/routeRegistry";

/**
 * View-switch chords.
 *
 * D4: the bindings themselves now live in the one route registry
 * (`@/lib/routeRegistry`). This module is a thin compatibility/derivation
 * layer so the historical shifted-character contract stays testable.
 *
 * Layout fix (D4, item 4): `resolveViewHotkey` matches on the PHYSICAL key
 * (`KeyboardEvent.code`) first, so Ctrl+Shift+<number> works on AZERTY,
 * QWERTZ, Dvorak, etc. The old shifted-glyph map below is retained purely as
 * a fallback for events that do not carry `code`.
 */
export const VIEW_HOTKEY_MAP: Record<string, AppView> = Object.fromEntries(
  hotkeyRoutes()
    // Number-row chords only — the mnemonic letter chords (Ctrl+Shift+W /
    // Ctrl+Shift+D) never had shifted-glyph entries in this map.
    .filter((route) => route.hotkey.code.startsWith("Digit"))
    .map((route) => [route.hotkey.legacyKey, route.id]),
);

export { resolveViewHotkey };
