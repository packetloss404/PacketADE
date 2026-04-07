import { ShieldCheck, ShieldX, XCircle } from "lucide-react";

interface ApprovalOverlayProps {
  onApprove: () => void;
  onDeny: () => void;
  onAbort: () => void;
}

export function ApprovalOverlay({ onApprove, onDeny, onAbort }: ApprovalOverlayProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 px-3 py-1.5 bg-accent-amber/10 border-t border-accent-amber/30 backdrop-blur-sm">
      <ShieldCheck size={12} className="text-accent-amber flex-shrink-0" />
      <span className="text-[11px] text-accent-amber font-medium flex-1">
        Approval needed
      </span>
      <button
        onClick={onApprove}
        className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors"
      >
        <ShieldCheck size={10} />
        Allow (y)
      </button>
      <button
        onClick={onDeny}
        className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded bg-accent-red/20 text-accent-red hover:bg-accent-red/30 transition-colors"
      >
        <ShieldX size={10} />
        Deny (n)
      </button>
      <button
        onClick={onAbort}
        className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded bg-text-muted/20 text-text-secondary hover:bg-text-muted/30 transition-colors"
      >
        <XCircle size={10} />
        Abort (Esc)
      </button>
    </div>
  );
}
