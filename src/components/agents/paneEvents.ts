/**
 * Typed CustomEvent channel for "open this header control" requests.
 *
 * Slash commands (/permissions, /model) need to pop UI that lives in the
 * chat header, far from the composer. The old implementation reached across
 * the tree with `document.querySelector` on data attributes plus a
 * setTimeout'd synthetic click; this replaces that with the same
 * window-CustomEvent convention the login flows already use
 * (`packetade:open-claude-login`). The owning component subscribes while
 * mounted and opens itself when the conversation id matches.
 */

export const OPEN_MODE_CHIP_EVENT = "packetade:open-mode-chip";
export const OPEN_MODEL_DROPDOWN_EVENT = "packetade:open-model-dropdown";

export interface PaneControlEventDetail {
  conversationId: string;
}

/** `/permissions` → open the AgentModeChip fine-flags popover. */
export function requestOpenModeChipPopover(conversationId: string): void {
  window.dispatchEvent(
    new CustomEvent<PaneControlEventDetail>(OPEN_MODE_CHIP_EVENT, {
      detail: { conversationId },
    }),
  );
}

/** `/model` → open the header model dropdown. */
export function requestOpenModelDropdown(conversationId: string): void {
  window.dispatchEvent(
    new CustomEvent<PaneControlEventDetail>(OPEN_MODEL_DROPDOWN_EVENT, {
      detail: { conversationId },
    }),
  );
}

/** Shared subscribe helper: runs `onMatch` when the event targets `conversationId`. */
export function addPaneControlListener(
  eventName: string,
  conversationId: string,
  onMatch: () => void,
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<PaneControlEventDetail>).detail;
    if (detail?.conversationId === conversationId) onMatch();
  };
  window.addEventListener(eventName, handler);
  return () => window.removeEventListener(eventName, handler);
}
