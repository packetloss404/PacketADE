import { X } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";

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
  /** When true, pressing Escape closes the modal unless `closeDisabled` is
   *  set. Defaults to false to preserve existing modal behavior — callers
   *  with inline inputs that handle Escape themselves should leave this off.
   *  Modals like `CodeQualityModal` that want OS-standard close-on-Escape
   *  pass `closeOnEscape` explicitly. */
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
  closeOnEscape = false,
}: ModalProps) {
  // Escape-to-close. Skipped when an unbreakable op is in flight or when the
  // caller opts out. Listens on the window so it works regardless of focus
  // target inside the modal.
  useEffect(() => {
    if (!closeOnEscape || closeDisabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't intercept if the user is mid-IME composition.
      if (e.isComposing) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeOnEscape, closeDisabled, onClose]);

  const containerClasses = fullscreen
    ? "bg-bg-secondary border border-bg-border rounded-lg w-[96vw] h-[94vh] overflow-hidden flex flex-col"
    : `bg-bg-secondary border border-bg-border rounded-lg ${width} max-h-[85vh] overflow-hidden flex flex-col`;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className={containerClasses}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-bg-border">
          <div className="flex items-center gap-2 min-w-0">
            {icon}
            <h2 className="text-sm font-semibold text-text-primary truncate">{title}</h2>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {headerExtra}
            <button
              onClick={onClose}
              disabled={closeDisabled}
              aria-label="Close"
              title={closeDisabled ? "Cannot close while busy" : "Close (Esc)"}
              className={`p-1 transition-colors ${closeDisabled ? "text-text-faint cursor-not-allowed opacity-40" : "text-text-muted hover:text-text-primary"}`}
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
        {footer && (
          <div className="px-5 py-3 border-t border-bg-border">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
