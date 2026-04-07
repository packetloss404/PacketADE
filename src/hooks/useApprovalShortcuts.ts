import { useEffect, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";

interface UseApprovalShortcutsOptions {
  showApproval: boolean;
  xtermRef: RefObject<Terminal | null>;
  onApprove: () => void;
  onDeny: () => void;
  onAbort: () => void;
}

export function useApprovalShortcuts({
  showApproval,
  xtermRef,
  onApprove,
  onDeny,
  onAbort,
}: UseApprovalShortcutsOptions) {
  useEffect(() => {
    if (!showApproval) return;
    const term = xtermRef.current;
    if (term) term.blur();

    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        onApprove();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        onDeny();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onAbort();
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (term) term.focus();
    };
  }, [showApproval, onApprove, onDeny, onAbort, xtermRef]);
}
