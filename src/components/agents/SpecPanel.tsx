import { useEffect, useState } from "react";
import { ListChecks, Plus, Check, X, Trash2 } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import type { AgentConversation } from "@/types/agent-conversation";

interface SpecPanelProps {
  conversation: AgentConversation;
}

/**
 * F10 — editable success-criteria list shown when `conversation.specStage`
 * is `"spec"`. Sits above PlanPanel in the chat header so the Spec → Plan
 * → Code FSM reads top-to-bottom in the UI.
 *
 * The criteria are user-editable bullets. "Lock spec & request plan" hands
 * off to `approveSpec` which posts a synthetic user turn asking the agent
 * for a structured TodoWrite plan.
 *
 * Renders nothing when the conversation isn't in spec stage.
 */
export function SpecPanel({ conversation }: SpecPanelProps) {
  const setSpec = useAgentTaskStore((s) => s.setSpec);
  const approveSpec = useAgentTaskStore((s) => s.approveSpec);

  const [draft, setDraft] = useState<string[]>(
    conversation.spec?.criteria ?? [],
  );
  const [newBullet, setNewBullet] = useState("");

  // Re-seed draft whenever the conversation's stored criteria change (e.g.
  // model-refined spec arrives via a different flow).
  useEffect(() => {
    if (conversation.spec) setDraft(conversation.spec.criteria);
  }, [conversation.spec]);

  if (conversation.specStage !== "spec") return null;

  function commitDraft(next: string[]) {
    setDraft(next);
    setSpec(conversation.id, next);
  }

  function addBullet() {
    const t = newBullet.trim();
    if (!t) return;
    commitDraft([...draft, t]);
    setNewBullet("");
  }

  function updateAt(i: number, val: string) {
    const next = draft.slice();
    next[i] = val;
    commitDraft(next);
  }

  function removeAt(i: number) {
    commitDraft(draft.filter((_, j) => j !== i));
  }

  const canApprove = draft.length > 0 && draft.every((c) => c.trim().length > 0);

  return (
    <div className="shrink-0 border-b border-bg-border bg-bg-secondary">
      <div className="flex items-center gap-2 px-3 py-2">
        <ListChecks size={11} className="text-accent-blue shrink-0" />
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          Spec
        </span>
        <span className="text-[10px] text-text-secondary">
          {draft.length} criteria
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => approveSpec(conversation.id)}
            disabled={!canApprove}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10 disabled:opacity-40"
            title="Lock the spec and ask the agent for a structured Plan"
          >
            <Check size={11} /> Lock & request plan
          </button>
        </div>
      </div>
      <ul className="px-3 pb-2 pt-0 space-y-1">
        {draft.map((item, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="text-[10px] text-text-faint w-4 tabular-nums">
              {i + 1}.
            </span>
            <input
              type="text"
              value={item}
              onChange={(e) => updateAt(i, e.target.value)}
              className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-0.5 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60"
            />
            <button
              type="button"
              onClick={() => removeAt(i)}
              className="p-0.5 text-text-faint hover:text-accent-red"
              title="Remove criterion"
            >
              <Trash2 size={11} />
            </button>
          </li>
        ))}
        <li className="flex items-center gap-2">
          <span className="text-[10px] text-text-faint w-4">
            <Plus size={11} />
          </span>
          <input
            type="text"
            value={newBullet}
            onChange={(e) => setNewBullet(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addBullet();
              }
              if (e.key === "Escape") {
                setNewBullet("");
              }
            }}
            placeholder="Add a success criterion (Enter to add)…"
            className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-0.5 text-[11px] text-text-primary placeholder:text-text-faint focus:outline-none focus:border-accent-blue/60"
          />
          {newBullet.trim() && (
            <button
              type="button"
              onClick={addBullet}
              className="p-0.5 text-accent-green hover:bg-accent-green/10 rounded"
              title="Add criterion"
            >
              <Check size={11} />
            </button>
          )}
        </li>
        {draft.length === 0 && (
          <li className="text-[10px] text-text-muted px-1 py-1">
            <X size={9} className="inline mr-1" /> No criteria yet — list a few
            success conditions, then lock the spec to ask the agent for a plan.
          </li>
        )}
      </ul>
    </div>
  );
}
