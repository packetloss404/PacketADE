import { Check, X, FileEdit, ShieldAlert, Ban } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import type {
  PendingEdit,
  PendingPermission,
} from "@/types/agent-conversation";

interface PendingApprovalsRollupProps {
  pendingEdits: PendingEdit[];
  pendingPermissions: PendingPermission[];
  onApplyAllEdits: () => void;
  onRejectAllEdits: () => void;
  onAllowAllPermissions: () => void;
  onDenyAllPermissions: () => void;
  /** F8: cancel ALL parked prompts (edits + permissions) without killing
   * the session. The model gets synthetic "User cancelled this tool"
   * results and continues — distinct from per-item Reject (model is told
   * "don't do this thing") in user intent. */
  onCancelAllPending: () => void;
}

/**
 * Compact "approve all N" rollup that appears above the per-item cards when
 * the agent has stacked up multiple pending writes or permission requests.
 *
 * Showing this rollup is the cheap half of the plan's batch-approval slice;
 * per-hunk diff acceptance needs a protocol bump (the current edit_response
 * is yes/no on the whole file) so it ships in a follow-up.
 */
export function PendingApprovalsRollup({
  pendingEdits,
  pendingPermissions,
  onApplyAllEdits,
  onRejectAllEdits,
  onAllowAllPermissions,
  onDenyAllPermissions,
  onCancelAllPending,
}: PendingApprovalsRollupProps) {
  const showEditsRollup = pendingEdits.length >= 2;
  const showPermsRollup = pendingPermissions.length >= 2;
  // Show the cancel-all chip whenever there's >=2 pending items in TOTAL,
  // even if no single category individually crosses the rollup threshold.
  const totalPending = pendingEdits.length + pendingPermissions.length;
  const showCancelAll = totalPending >= 2;
  if (!showEditsRollup && !showPermsRollup && !showCancelAll) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {showCancelAll && !showEditsRollup && !showPermsRollup && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-bg-border bg-bg-secondary">
          <Ban size={12} className="text-text-muted shrink-0" />
          <span className="text-[11px] text-text-secondary flex-1">
            {totalPending} pending tools waiting on you
          </span>
          <Tooltip content="Drain all parked prompts as denied — agent loop continues, model sees synthetic 'user cancelled' results">
            <button
              type="button"
              onClick={onCancelAllPending}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-bg-border text-text-secondary hover:bg-bg-hover transition-colors"
            >
              <Ban size={11} /> Cancel pending
            </button>
          </Tooltip>
        </div>
      )}
      {showEditsRollup && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-accent-amber/40 bg-accent-amber/5">
          <FileEdit size={12} className="text-accent-amber shrink-0" />
          <span className="text-[11px] text-text-secondary flex-1">
            {pendingEdits.length} pending file edits
          </span>
          <Tooltip content="Apply every staged write_file in one go">
            <button
              type="button"
              onClick={onApplyAllEdits}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-accent-green/20 hover:bg-accent-green/30 text-accent-green font-medium transition-colors"
            >
              <Check size={11} /> Apply all
            </button>
          </Tooltip>
          <Tooltip content="Reject every staged write_file">
            <button
              type="button"
              onClick={onRejectAllEdits}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-accent-red/15 hover:bg-accent-red/25 text-accent-red font-medium transition-colors"
            >
              <X size={11} /> Reject all
            </button>
          </Tooltip>
          <Tooltip content="Cancel all parked prompts — agent loop continues">
            <button
              type="button"
              onClick={onCancelAllPending}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-bg-border text-text-muted hover:bg-bg-hover transition-colors"
            >
              <Ban size={11} />
            </button>
          </Tooltip>
        </div>
      )}
      {showPermsRollup && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-accent-amber/40 bg-accent-amber/5">
          <ShieldAlert size={12} className="text-accent-amber shrink-0" />
          <span className="text-[11px] text-text-secondary flex-1">
            {pendingPermissions.length} pending tool permissions
          </span>
          <Tooltip content="Allow every pending tool call once">
            <button
              type="button"
              onClick={onAllowAllPermissions}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-accent-green/20 hover:bg-accent-green/30 text-accent-green font-medium transition-colors"
            >
              <Check size={11} /> Allow all
            </button>
          </Tooltip>
          <Tooltip content="Deny every pending tool call">
            <button
              type="button"
              onClick={onDenyAllPermissions}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-accent-red/15 hover:bg-accent-red/25 text-accent-red font-medium transition-colors"
            >
              <X size={11} /> Deny all
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
