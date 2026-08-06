import { X } from "lucide-react";
import { createContext, useContext, useEffect, useId, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { isTopModal, registerModal, unregisterModal } from "@/lib/modalStack";

/** Nesting depth of the enclosing Modal. A dialog rendered inside another
 *  dialog's children outranks it on the modal stack — see `lib/modalStack`. */
const ModalDepthContext = createContext(0);

/** Deliberately no visibility filtering: jsdom reports every element as
 *  unrendered, and a trap that silently finds nothing is worse than one that
 *  occasionally cycles through an off-screen control. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface ModalProps {
  onClose: () => void;
  title: string;
  icon?: ReactNode;
  width?: string;
  /** When true, the modal occupies almost the full viewport. Overrides `width`. */
  fullscreen?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  /** Optional content rendered in the header row, just before the close (X)
   *  button. Use for per-modal controls (refresh, toggle fullscreen, etc.).
   *  These controls remain enabled when `closeDisabled` is true. */
  headerExtra?: ReactNode;
  /** When true, the close (X) button is visually dimmed and click is a no-op
   *  (callers should also pass a no-op `onClose`). Useful while a modal is in
   *  the middle of an unbreakable operation. */
  closeDisabled?: boolean;
  /** Escape-to-close. **Defaults to true** — the header's X button advertises
   *  "Close (Esc)", so every modal honours it unless it has a reason not to.
   *  Pass `closeOnEscape={false}` only when the modal's body legitimately owns
   *  the Escape key (e.g. `TransientPtyModal`, where xterm forwards Escape to
   *  the PTY). Modals in the middle of an unbreakable operation should use
   *  `closeDisabled` (and/or a no-op `onClose`) instead — that already
   *  suppresses Escape. Inner controls that handle Escape themselves
   *  (Dropdown search, inline field editors) call `preventDefault()`, and a
   *  `defaultPrevented` Escape never reaches this handler. */
  closeOnEscape?: boolean;
}

export function Modal({
  onClose,
  title,
  icon,
  width = "w-[480px]",
  fullscreen = false,
  children,
  footer,
  headerExtra,
  closeDisabled = false,
  closeOnEscape = true,
}: ModalProps) {
  const parentDepth = useContext(ModalDepthContext);
  const depth = parentDepth + 1;
  const id = useId();
  const titleId = `${id}-title`;
  const containerRef = useRef<HTMLDivElement>(null);

  // Join the modal stack for the whole mounted lifetime, regardless of
  // `closeOnEscape` / `closeDisabled`: a dialog that declines Escape still owns
  // it while it is on top, and must not let the dialog underneath act instead.
  // Declared first so it lands before the Escape listener below.
  useEffect(() => {
    registerModal(id, depth);
    return () => unregisterModal(id);
  }, [id, depth]);

  // Escape-to-close. Skipped when an unbreakable op is in flight or when the
  // caller opts out. Listens on the window so it works regardless of focus
  // target inside the modal — including text inputs, which is what users
  // expect from an OS-standard dialog.
  useEffect(() => {
    if (!closeOnEscape || closeDisabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't intercept if the user is mid-IME composition.
      if (e.isComposing) return;
      // Escape layering (matches ReviewSurface): an inner layer that already
      // handled this keypress — an open Dropdown's search box, an inline
      // field editor, the command palette, a live dictation capture — marks
      // it handled. One Escape must only unwind one layer.
      if (e.defaultPrevented) return;
      // Nested dialogs: only the top-most one unwinds.
      if (!isTopModal(id)) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeOnEscape, closeDisabled, onClose, id]);

  // Move focus into the dialog on open and hand it back to whatever had it on
  // close. Passive effect (not layout) so a consumer's `autoFocus` has already
  // landed by the time this runs and we can leave it alone.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (!container.contains(document.activeElement)) {
      const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? container).focus();
    }
    return () => {
      if (
        previouslyFocused &&
        previouslyFocused !== document.body &&
        document.contains(previouslyFocused)
      ) {
        previouslyFocused.focus();
      }
    };
  }, []);

  // Tab trap. Bound to the container rather than the window so a nested dialog
  // handles its own Tab first; the outer instance sees the bubbled event but
  // yields because it is no longer top-most.
  const handleContainerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    if (!isTopModal(id)) return;
    const container = containerRef.current;
    if (!container) return;

    const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const outside = !active || active === container || !container.contains(active);

    if (e.shiftKey) {
      if (outside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (outside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const containerClasses = fullscreen
    ? "bg-bg-secondary border border-bg-border rounded-lg w-[96vw] h-[94vh] overflow-hidden flex flex-col"
    : `bg-bg-secondary border border-bg-border rounded-lg ${width} max-h-[85vh] overflow-hidden flex flex-col`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleContainerKeyDown}
        className={`${containerClasses} focus:outline-none`}
      >
        <ModalDepthContext.Provider value={depth}>
          <div className="flex items-center justify-between border-b border-bg-border px-5 py-3">
            <div className="flex min-w-0 items-center gap-2">
              {icon}
              <h2 id={titleId} className="truncate text-sm font-semibold text-text-primary">
                {title}
              </h2>
            </div>
            <div className="flex flex-shrink-0 items-center gap-1">
              {headerExtra}
              <button
                onClick={onClose}
                disabled={closeDisabled}
                aria-label="Close"
                title={closeDisabled ? "Cannot close while busy" : "Close (Esc)"}
                className={`p-1 transition-colors ${closeDisabled ? "cursor-not-allowed text-text-faint opacity-40" : "text-text-muted hover:text-text-primary"}`}
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">{children}</div>
          {footer && <div className="border-t border-bg-border px-5 py-3">{footer}</div>}
        </ModalDepthContext.Provider>
      </div>
    </div>
  );
}
