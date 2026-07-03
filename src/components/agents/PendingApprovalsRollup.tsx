import { Check, X, ShieldAlert, Ban } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import type { PendingPermission } from "@/types/agent-conversation";

interface PendingApprovalsRollupProps {
  pendingPermissions: PendingPermission[];
  onAllowAllPermissions: () => void;
  onDenyAllPermissions: () => void;
  /** F8: cancel ALL parked prompts (permissions + gated edits) without
   * killing the session. The model gets synthetic "User cancelled this
   * tool" results and continues — distinct from per-item Deny (model is
   * told "don't do this thing") in user intent. */
  onCancelAllPending: () => void;
}

/**
 * Compact "allow all N" rollup that appears above the per-item permission
 * prompts when the agent has stacked up multiple pending requests.
 *
 * P1-8: this rollup is permissions-only. Pending file edits live in the
 * canonical review surface (ReviewBar / ReviewSurface) with the Keep/Undo
 * verb pair — the old duplicated edit banners ("Accept all" vs "Apply all")
 * died with the merge, and the two verb pairs are never mixed here.
 */
export function PendingApprovalsRollup({
  pendingPermissions,
  onAllowAllPermissions,
  onDenyAllPermissions,
  onCancelAllPending,
}: PendingApprovalsRollupProps) {
  if (pendingPermissions.length < 2) return null;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-accent-amber/40 bg-accent-amber/5">
      <ShieldAlert size={12} className="text-accent-amber shrink-0" />
      <span className="text-ui text-text-secondary flex-1">
        {pendingPermissions.length} pending tool permissions
      </span>
      <Tooltip content="Allow every pending tool call once">
        <button
          type="button"
          onClick={onAllowAllPermissions}
          className="flex items-center gap-1 text-ui px-2 py-0.5 rounded bg-accent-green/20 hover:bg-accent-green/30 text-accent-green font-medium transition-colors"
        >
          <Check size={11} /> Allow all
        </button>
      </Tooltip>
      <Tooltip content="Deny every pending tool call">
        <button
          type="button"
          onClick={onDenyAllPermissions}
          className="flex items-center gap-1 text-ui px-2 py-0.5 rounded bg-accent-red/15 hover:bg-accent-red/25 text-accent-red font-medium transition-colors"
        >
          <X size={11} /> Deny all
        </button>
      </Tooltip>
      <Tooltip content="Cancel all parked prompts — agent loop continues">
        <button
          type="button"
          onClick={onCancelAllPending}
          className="flex items-center gap-1 text-ui px-2 py-0.5 rounded border border-bg-border text-text-muted hover:bg-bg-hover transition-colors"
        >
          <Ban size={11} />
        </button>
      </Tooltip>
    </div>
  );
}
