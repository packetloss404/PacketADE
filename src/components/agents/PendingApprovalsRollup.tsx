import { Check, X, ShieldAlert } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import type { PendingPermission } from "@/types/agent-conversation";

interface PendingApprovalsRollupProps {
  pendingPermissions: PendingPermission[];
  onAllowAllPermissions: () => void;
  onDenyAllPermissions: () => void;
}

/**
 * Compact "allow all N" rollup that appears above the per-item permission
 * prompts when the agent has stacked up multiple pending requests.
 *
 * B3 (wave 2c): it renders INLINE in the transcript, once, above the first
 * card in the queue — its verbs act on the whole queue, so a copy at every
 * call site would be N buttons that all do the same thing.
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
}: PendingApprovalsRollupProps) {
  if (pendingPermissions.length < 2) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-accent-amber/40 bg-accent-amber/5 px-2.5 py-1.5">
      <ShieldAlert size={12} className="text-accent-amber shrink-0" />
      <span className="text-ui text-text-secondary flex-1">
        {pendingPermissions.length} pending tool permissions
      </span>
      <Tooltip content="Allow every pending tool call once">
        <button
          type="button"
          onClick={onAllowAllPermissions}
          className="flex items-center gap-1 text-ui px-2.5 py-1 rounded-lg border border-accent-green/40 bg-accent-green/20 hover:bg-accent-green/30 text-accent-green font-semibold transition-colors"
        >
          <Check size={11} /> Allow all
        </button>
      </Tooltip>
      <Tooltip content="Deny every pending tool call">
        <button
          type="button"
          onClick={onDenyAllPermissions}
          className="flex items-center gap-1 text-ui px-2.5 py-1 rounded-lg border border-accent-red/40 bg-accent-red/15 hover:bg-accent-red/25 text-accent-red font-semibold transition-colors"
        >
          <X size={11} /> Deny all
        </button>
      </Tooltip>
    </div>
  );
}
