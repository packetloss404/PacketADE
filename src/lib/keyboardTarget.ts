/**
 * Focus classification for global keyboard shortcuts.
 *
 * UX-08: the app-level keydown listeners used to fire regardless of where
 * focus was, so readline's kill-line (Ctrl+K) both reached the shell **and**
 * popped the command palette over the user's terminal. Global chords must
 * yield to the surface that owns the keystroke:
 *
 *   - an xterm terminal (the PTY owns every key, including Ctrl+K/Escape),
 *   - a text input / textarea / select,
 *   - a contenteditable region.
 *
 * These helpers are the single definition of "the user is typing"; every
 * global listener should route its guard through them rather than
 * re-deriving a tag check.
 */

/** Elements whose own key handling always outranks a global shortcut. */
const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * xterm renders a focus-holding `<textarea class="xterm-helper-textarea">`
 * inside a `.xterm` container, so a focused terminal already trips the tag
 * check. The container lookup is belt-and-braces: it also covers keydowns
 * raised on the viewport/screen elements (e.g. synthetic events, or a click
 * landing on the canvas before the helper textarea takes focus).
 */
const TERMINAL_SELECTOR = ".xterm, .xterm-helper-textarea, [data-dictation-pty-session]";

function toElement(source: Event | EventTarget | Element | null): Element | null {
  // Order matters: `<a>`/`<form>` elements own a `target` property, so an
  // `"target" in source` sniff would read the wrong thing for them.
  const target = source instanceof Event ? source.target : source;
  return target instanceof Element ? target : null;
}

/** True when the event originated inside a live xterm terminal. */
export function isTerminalTarget(source: Event | EventTarget | Element | null): boolean {
  const el = toElement(source);
  return !!el?.closest(TERMINAL_SELECTOR);
}

/**
 * True when the event originated inside a terminal or any editable control
 * (input/textarea/select/contenteditable). Global shortcuts should return
 * early when this is true.
 */
export function isEditableTarget(source: Event | EventTarget | Element | null): boolean {
  const el = toElement(source);
  if (!el) return false;
  if (isTerminalTarget(el)) return true;
  if (EDITABLE_TAGS.has(el.tagName)) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return !!el.closest('[contenteditable]:not([contenteditable="false"])');
}
