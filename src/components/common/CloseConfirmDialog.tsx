import { AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { describeLiveWork, type LiveWorkSummary } from "@/lib/liveWork";

interface CloseConfirmDialogProps {
  summary: LiveWorkSummary;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * UX-09 confirmation: shown only when a close request would destroy live work.
 * Lists what dies, by kind and count. Cancel is the safe default — it owns
 * Escape and the modal's X; only the explicit "Close anyway" destroys the
 * window.
 */
export function CloseConfirmDialog({ summary, onCancel, onConfirm }: CloseConfirmDialogProps) {
  const lines = describeLiveWork(summary);

  return (
    <Modal
      title="Close PacketADE?"
      icon={<AlertTriangle size={14} className="text-accent-amber" />}
      onClose={onCancel}
      closeOnEscape
      width="w-[420px]"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Close anyway
          </Button>
        </div>
      }
    >
      <div className="px-5 py-4">
        <p className="text-xs text-text-secondary">
          Closing now terminates work that is still running. Nothing is resumed on restart.
        </p>
        <ul className="mt-3 space-y-1.5">
          {lines.map((line) => (
            <li key={line} className="flex items-start gap-2 text-xs text-text-primary">
              <span className="mt-[5px] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-red" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
