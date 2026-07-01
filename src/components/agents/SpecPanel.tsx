import { useEffect, useState } from "react";
import { ListChecks, Plus, Check, X, Trash2 } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import type { AgentConversation } from "@/types/agent-conversation";

interface SpecPanelProps {
  conversation: AgentConversation;
}

/** A success criterion plus a stable id for keying controlled inputs. */
interface Criterion {
  id: string;
  text: string;
}

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c-${Math.random().toString(36).slice(2)}`;
}

function toCriteria(criteria: string[]): Criterion[] {
  return criteria.map((text) => ({ id: makeId(), text }));
}

function sameText(rows: Criterion[], criteria: string[]): boolean {
  return (
    rows.length === criteria.length &&
    rows.every((r, i) => r.text === criteria[i])
  );
}

/**
 * F10 — editable success-criteria list shown when the plan substore's
 * `specStage` for this conversation is `"spec"`. Sits above PlanPanel in
 * the chat header so the Spec → Plan → Code FSM reads top-to-bottom in
 * the UI.
 *
 * Reads/writes the spec via agentPlanStore (split out of agentTaskStore).
 * Renders nothing when the conversation isn't in spec stage.
 */
export function SpecPanel({ conversation }: SpecPanelProps) {
  const setSpec = useAgentPlanStore((s) => s.setSpec);
  const approveSpec = useAgentPlanStore((s) => s.approveSpec);
  const spec = useAgentPlanStore((s) => s.spec.get(conversation.id));
  const specStage = useAgentPlanStore((s) => s.specStage.get(conversation.id));

  // Editable rows carry a stable id so controlled-input focus/edits stay put
  // when earlier rows are removed (keying by array index reuses DOM nodes and
  // lands edits on the wrong row).
  const [draft, setDraft] = useState<Criterion[]>(() =>
    toCriteria(spec?.criteria ?? []),
  );
  const [newBullet, setNewBullet] = useState("");

  // Re-seed draft only when the stored criteria genuinely differ from what we
  // have locally (e.g. a model-refined spec arrives via a different flow) — not
  // after our own commits, which would clobber in-flight edits and re-render.
  useEffect(() => {
    if (!spec) return;
    setDraft((prev) =>
      sameText(prev, spec.criteria) ? prev : toCriteria(spec.criteria),
    );
  }, [spec]);

  if (specStage !== "spec") return null;

  // Persist the draft to the store. Called on structural changes (add/remove)
  // and on blur — not on every keystroke, to avoid a store write + scheduled
  // persistence per character.
  function commitToStore(next: Criterion[]) {
    setSpec(
      conversation.id,
      next.map((c) => c.text),
    );
  }

  function addBullet() {
    const t = newBullet.trim();
    if (!t) return;
    const next = [...draft, { id: makeId(), text: t }];
    setDraft(next);
    commitToStore(next);
    setNewBullet("");
  }

  function updateAt(id: string, val: string) {
    setDraft((prev) => prev.map((c) => (c.id === id ? { ...c, text: val } : c)));
  }

  function removeAt(id: string) {
    const next = draft.filter((c) => c.id !== id);
    setDraft(next);
    commitToStore(next);
  }

  const canApprove =
    draft.length > 0 && draft.every((c) => c.text.trim().length > 0);

  return (
    <div className="shrink-0 border-b border-bg-border bg-bg-secondary">
      <div className="flex items-center gap-2 px-3 py-2">
        <ListChecks size={11} className="text-accent-blue shrink-0" />
        <span className="text-[10px] uppercase tracking-wide font-semibold text-text-secondary">
          Spec
        </span>
        <span className="text-[10px] text-text-secondary">
          {draft.length} criteria
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip content="Lock the spec and ask the agent for a structured Plan">
            <button
              type="button"
              onClick={() => {
                commitToStore(draft);
                approveSpec(conversation.id);
              }}
              disabled={!canApprove}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-accent-green/20 hover:bg-accent-green/30 text-accent-green font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check size={11} /> Lock & request plan
            </button>
          </Tooltip>
        </div>
      </div>
      <ul className="px-3 pb-2 pt-0 space-y-1">
        {draft.map((item, i) => (
          <li key={item.id} className="flex items-center gap-2">
            <span className="text-[10px] text-text-faint w-4 tabular-nums">
              {i + 1}.
            </span>
            <input
              type="text"
              value={item.text}
              onChange={(e) => updateAt(item.id, e.target.value)}
              onBlur={() => commitToStore(draft)}
              aria-label={`Success criterion ${i + 1}`}
              className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-0.5 text-[11px] text-text-primary focus:outline-none focus:border-accent-green/50"
            />
            <Tooltip content="Remove criterion">
              <button
                type="button"
                onClick={() => removeAt(item.id)}
                className="p-0.5 text-text-faint hover:text-accent-red transition-colors"
                aria-label={`Remove criterion ${i + 1}`}
              >
                <Trash2 size={11} />
              </button>
            </Tooltip>
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
            aria-label="Add a success criterion"
            className="flex-1 bg-bg-primary border border-bg-border rounded px-2 py-0.5 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green/50"
          />
          {newBullet.trim() && (
            <Tooltip content="Add criterion">
              <button
                type="button"
                onClick={addBullet}
                className="p-0.5 text-accent-green hover:bg-accent-green/10 rounded transition-colors"
                aria-label="Add criterion"
              >
                <Check size={11} />
              </button>
            </Tooltip>
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
