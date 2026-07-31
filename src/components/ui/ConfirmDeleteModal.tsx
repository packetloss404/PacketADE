/**
 * The sanctioned confirm for record-destroying actions.
 *
 * Before this existed the codebase carried five competing idioms — a styled
 * `Modal` (FleetSidebar/AgentSidebar), `window.confirm`, a 3-second armed
 * inline button, an in-place "Confirm" swap with no cancel, and — most
 * commonly — nothing at all. `window.confirm` is not usable here: it is
 * unstyled, untestable, blocks the webview, and in a Tauri window it renders
 * as an OS chrome dialog that does not name the app.
 *
 * The contract this component enforces:
 *   - the destructive call happens ONLY from the explicit confirm button;
 *   - Cancel / Esc / the header X all back out with zero mutation;
 *   - the record is NAMED, so the user can see what they are about to lose;
 *   - `warnings` states live consequences (in-use, connected, running work)
 *     instead of leaving the user to discover them afterwards.
 *
 * Reuse this rather than hand-rolling a sixth idiom.
 */
import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";

export interface ConfirmDeleteModalProps {
  /** Names the entity kind, e.g. "Delete server?" — never a bare "Are you sure?". */
  title: string;
  /** The specific record being destroyed. Rendered quoted in the body. */
  entityName?: string;
  /** What removal actually does. Shown after the name. */
  description?: ReactNode;
  /**
   * Live consequences the user cannot see from the row they clicked — e.g.
   * "Connected right now", "2 conversations are running on it". Rendered in
   * an amber callout above the confirm button. Empty array renders nothing.
   */
  warnings?: string[];
  /** Heading for the warning callout. */
  warningTitle?: string;
  /** Confirm button label. Defaults to "Delete". */
  confirmLabel?: string;
  /** Reversibility note. Pass `null` for reversible actions (e.g. archive). */
  undoNote?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDeleteModal({
  title,
  entityName,
  description,
  warnings = [],
  warningTitle = "This is in use right now",
  confirmLabel = "Delete",
  undoNote = "This cannot be undone.",
  onConfirm,
  onClose,
}: ConfirmDeleteModalProps) {
  return (
    <Modal
      title={title}
      width="w-[420px]"
      closeOnEscape
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-ui text-text-secondary transition-colors hover:bg-bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="bg-accent-red/15 hover:bg-accent-red/25 rounded px-3 py-1.5 text-ui font-medium text-accent-red transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <div className="px-5 py-4">
        <p className="text-ui text-text-secondary">
          {entityName ? (
            <>
              <span className="text-text-primary">“{entityName}”</span>{" "}
            </>
          ) : null}
          {description}
        </p>

        {warnings.length > 0 && (
          <div
            role="alert"
            className="border-accent-amber/30 bg-accent-amber/10 mt-3 rounded border px-3 py-2"
          >
            <div className="flex items-center gap-1.5 text-meta font-medium text-accent-amber">
              <AlertTriangle size={11} />
              {warningTitle}
            </div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-meta text-text-secondary">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {undoNote && <p className="mt-2 text-meta text-text-muted">{undoNote}</p>}
      </div>
    </Modal>
  );
}
