import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { useMissionPlannerStore, type MissionApprovalRequest } from "@/stores/missionPlannerStore";
import { relativeTime } from "@/lib/time";

interface PlannerApprovalGateProps {
  missionId: string;
}

/**
 * E2 — inline approval gate. Surfaces a single pending approval from the
 * mission planner (`request_user_approval` tool) and routes the user's
 * answer back via `resolveMissionApproval`. Renders nothing when no
 * approvals are pending for `missionId`.
 *
 * UX contract (per `dev/mission-planner-plan.md` D1):
 *   - Inline banner (NOT a modal) — the planner is async and the user
 *     may want to keep reading the journal while answering.
 *   - One approval at a time; oldest first. Resolved approvals optimistically
 *     disappear so the user sees immediate feedback.
 *   - Resolution choices: option label, free-text answer, "Acknowledge"
 *     (when no options), or "Dismiss" (`"dismissed"` sentinel).
 */
export function PlannerApprovalGate({ missionId }: PlannerApprovalGateProps) {
  const approvals = useMissionPlannerStore((s) => s.pendingApprovals.get(missionId));
  const hydratePendingApprovals = useMissionPlannerStore((s) => s.hydratePendingApprovals);
  const resolveApproval = useMissionPlannerStore((s) => s.resolveApproval);

  useEffect(() => {
    void hydratePendingApprovals(missionId).catch((err) => {
      console.warn("Failed to hydrate mission planner approvals", missionId, err);
    });
  }, [hydratePendingApprovals, missionId]);

  const oldest = useMemo<MissionApprovalRequest | null>(() => {
    if (!approvals || approvals.length === 0) return null;
    return [...approvals].sort((a, b) => a.awaitingSince - b.awaitingSince)[0];
  }, [approvals]);

  if (!oldest) return null;
  const queued = approvals ? approvals.length - 1 : 0;

  return (
    <ApprovalCard
      key={oldest.id}
      approval={oldest}
      queued={queued}
      onResolve={(choice) => resolveApproval(missionId, oldest.id, choice)}
    />
  );
}

interface ApprovalCardProps {
  approval: MissionApprovalRequest;
  queued: number;
  onResolve(choice: string): Promise<void>;
}

function ApprovalCard({ approval, queued, onResolve }: ApprovalCardProps) {
  const [freeText, setFreeText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasOptions = approval.options.length > 0;

  async function handleResolve(choice: string) {
    if (busy) return;
    const trimmed = choice.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onResolve(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve approval");
      setBusy(false);
    }
    // On success the parent unmounts this card (approval removed from state),
    // so no need to flip `busy` back.
  }

  return (
    <div className="bg-accent-amber/10 border-accent-amber/30 flex flex-col gap-2 rounded border px-3 py-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-accent-amber" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-amber">
              Planner needs you
            </span>
            <span className="font-mono text-[10px] text-text-muted">
              asked {relativeTime(approval.awaitingSince)}
            </span>
            {queued > 0 && (
              <span className="text-[10px] text-text-muted">· {queued} more queued</span>
            )}
          </div>
          <div className="text-xs text-text-primary">
            <MarkdownRenderer content={approval.question} />
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleResolve("dismissed")}
          disabled={busy}
          className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          title="Dismiss (planner proceeds with default)"
        >
          <X size={12} />
        </button>
      </div>

      {hasOptions ? (
        <div className="flex flex-wrap items-center gap-1.5 pl-[22px]">
          {approval.options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => void handleResolve(opt)}
              disabled={busy}
              className="hover:bg-accent-green/20 inline-flex items-center gap-1 rounded border border-accent-line bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent-green transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 pl-[22px]">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = freeText.trim();
              if (value) {
                void handleResolve(value);
              } else {
                void handleResolve("acknowledged");
              }
            }}
            className="flex items-center gap-1.5"
          >
            <input
              type="text"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder="Type your answer, or press Acknowledge…"
              disabled={busy}
              className="flex-1 rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary outline-none placeholder:text-text-faint focus:border-accent-line disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={busy}
              className="hover:bg-accent-green/20 inline-flex items-center gap-1 rounded border border-accent-line bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent-green transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {freeText.trim() ? "Send" : "Acknowledge"}
            </button>
          </form>
        </div>
      )}

      {error && <div className="pl-[22px] text-[10px] text-accent-red">{error}</div>}
    </div>
  );
}
