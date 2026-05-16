import { X } from "lucide-react";
import type { ReactNode } from "react";

interface ModalProps {
  onClose: () => void;
  title: string;
  icon?: ReactNode;
  width?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** When true, the close (X) button is visually dimmed and click is a no-op
   *  (callers should also pass a no-op `onClose`). Useful while a modal is in
   *  the middle of an unbreakable operation. */
  closeDisabled?: boolean;
}

export function Modal({ onClose, title, icon, width = "w-[480px]", children, footer, closeDisabled = false }: ModalProps) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className={`bg-bg-secondary border border-bg-border rounded-lg ${width} max-h-[85vh] overflow-hidden flex flex-col`}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-bg-border">
          <div className="flex items-center gap-2">
            {icon}
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={closeDisabled}
            className={`p-1 transition-colors ${closeDisabled ? "text-text-faint cursor-not-allowed opacity-40" : "text-text-muted hover:text-text-primary"}`}
          >
            <X size={16} />
          </button>
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
