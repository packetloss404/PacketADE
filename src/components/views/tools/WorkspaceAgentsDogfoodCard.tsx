import { useState } from "react";
import { BarChart3, Copy, RotateCcw, ShieldCheck } from "lucide-react";
import {
  serializeWorkspaceAgentsDogfoodEvidence,
  useWorkspaceAgentsDogfoodStore,
  type WorkspaceAgentsDogfoodEvent,
} from "@/stores/workspaceAgentsDogfoodStore";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";

const HANDOFF_ROWS: Array<{
  event: WorkspaceAgentsDogfoodEvent;
  label: string;
}> = [
  { event: "agent_started_agents", label: "Agents launches" },
  { event: "workspace_delegated_agents", label: "Workspace → Agents" },
  {
    event: "agent_opened_workspace_project",
    label: "Agents → Workspace project",
  },
  { event: "agent_attached_terminal", label: "Attach terminal" },
  { event: "agent_packetcode_handoff", label: "PacketCode handoffs" },
  { event: "agent_opened_git_ending", label: "Git endings" },
  { event: "agent_linked_flight", label: "Agent → Flight" },
  {
    event: "flight_attempt_opened_workspace",
    label: "Attempt → Workspace",
  },
  { event: "agent_monitor_opened", label: "Agent monitors" },
  { event: "flight_monitor_opened", label: "Flight monitors" },
];

function durationLabel(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${(seconds / 60).toFixed(1)} min`;
}

export function WorkspaceAgentsDogfoodCard() {
  const evidence = useWorkspaceAgentsDogfoodStore((state) => state.evidence);
  const reset = useWorkspaceAgentsDogfoodStore((state) => state.reset);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingReset, setPendingReset] = useState(false);
  const averageAttentionMs =
    evidence.attention.samples > 0
      ? Math.round(evidence.attention.totalResponseMs / evidence.attention.samples)
      : 0;
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(serializeWorkspaceAgentsDogfoodEvidence());
      setNotice("Evidence copied");
    } catch {
      setNotice("Could not copy evidence");
    }
  }

  function performReset() {
    reset();
    setNotice("Local evidence reset");
    setPendingReset(false);
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="flex items-start gap-2">
        <BarChart3 size={14} className="mt-0.5 text-accent-blue" />
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold text-text-primary">
            Workspace/Agents migration evidence
          </h3>
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
            Local-only, content-free diagnostics for the Workspace/Agents migration. Nothing is
            uploaded and no prompts, transcripts, paths, files, diffs, repository URLs, tool
            arguments, or IDs are persisted here.
          </p>
        </div>
        <ShieldCheck size={14} className="text-accent-green" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {HANDOFF_ROWS.map((row) => (
          <div
            key={row.event}
            className="flex items-center justify-between rounded border border-bg-border bg-bg-primary px-2.5 py-1.5 text-ui"
          >
            <span className="text-text-secondary">{row.label}</span>
            <span className="font-mono tabular-nums text-text-primary">
              {evidence.counters[row.event]}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-ui">
        <Metric
          label="Max visible conversations"
          value={String(evidence.visibility.maxSimultaneousConversations)}
        />
        <Metric
          label="Attention response"
          value={
            evidence.attention.samples > 0
              ? `${durationLabel(averageAttentionMs)} avg · ${evidence.attention.samples} samples`
              : "No samples"
          }
        />
        <Metric
          label="Display topology"
          value={
            evidence.displayTopology.samples > 0
              ? `${evidence.displayTopology.singleDisplaySamples} single · ${evidence.displayTopology.multiDisplaySamples} multi`
              : "No samples"
          }
        />
        <Metric
          label="Compatibility panes"
          value={`${evidence.counters.compatibility_pane_loaded} loaded · ${evidence.counters.compatibility_pane_load_failed} failed`}
        />
        <Metric
          label="Migration audits"
          value={`${evidence.migration.audits} runs · ${evidence.migration.missingConversationReferences} missing refs · ${evidence.migration.orphanConversationWrappers} orphan wrappers`}
        />
        <Metric label="Evidence since" value={new Date(evidence.startedAt).toLocaleDateString()} />
      </div>

      <div className="mt-3 rounded border border-accent-line bg-accent-soft px-3 py-2">
        <div className="text-ui font-medium text-text-primary">Owner decision applied</div>
        <div className="mt-1 text-meta leading-relaxed text-text-secondary">
          New conversation attachments to Workspace are retired. Existing saved conversation panes
          remain load-compatible and removable.
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex items-center gap-1.5 rounded border border-bg-border px-2.5 py-1.5 text-ui text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          <Copy size={11} />
          Copy evidence JSON
        </button>
        <button
          type="button"
          onClick={() => setPendingReset(true)}
          className="flex items-center gap-1.5 rounded border border-bg-border px-2.5 py-1.5 text-ui text-text-muted hover:bg-bg-hover hover:text-accent-red"
        >
          <RotateCcw size={11} />
          Reset
        </button>
        {notice && <span className="text-meta text-text-muted">{notice}</span>}
      </div>

      {pendingReset && (
        <ConfirmDeleteModal
          title="Reset dogfood counters?"
          description="The local Workspace/Agents migration counters go back to zero. Copy the evidence JSON first if you still need it."
          confirmLabel="Reset counters"
          onConfirm={performReset}
          onClose={() => setPendingReset(false)}
        />
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-bg-border bg-bg-primary px-2.5 py-2">
      <div className="text-meta text-text-muted">{label}</div>
      <div className="mt-0.5 text-ui text-text-primary">{value}</div>
    </div>
  );
}
