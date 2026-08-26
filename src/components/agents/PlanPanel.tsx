import { useEffect, useMemo, useState } from "react";
import {
  CheckSquare,
  ChevronDown,
  Send,
  Square,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip } from "@/components/ui/Tooltip";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { API_PROVIDERS } from "@/lib/api-models";
import { buildHandoffPrompt } from "@/lib/conversationHandoff";
import {
  inheritSshTarget,
  isRemoteConversation,
  REMOTE_UNSUPPORTED_TOOLTIP,
} from "@/lib/remoteConversation";
import { parseToolInput } from "@/lib/parseToolInput";
import { capabilitiesFor } from "@/lib/agentCapabilities";
import { authStatusKey, useAuthStatusStore } from "@/stores/authStatusStore";
import { authProbeProvider, type AgentCli } from "@/stores/agentTaskStore";

import type {
  AgentConversation,
  AgentPlanItem,
  AgentToolCall,
} from "@/types/agent-conversation";

/** Executor a Claude planning conversation hands an approved plan to.
 * Was `api-openai-codex` (Codex `exec` on a ChatGPT subscription) until that
 * row was removed in 2026-07. */
const HANDOFF_EXECUTOR_AGENT: AgentCli = "api-openai-agents";

type PlanItemStatus = "pending" | "in_progress" | "completed";

interface PlanItem {
  status: PlanItemStatus;
  title: string;
}

/**
 * Parse the Claude Agent SDK's `TodoWrite` tool call. The input is JSON of
 * shape `{ todos: [{ content, status, activeForm }] }`. Tolerant of both
 * structured `input` (object) and stringified-JSON shapes.
 */
function parseTodoWrite(tc: AgentToolCall): PlanItem[] | null {
  const rec = parseToolInput(
    (tc as AgentToolCall & { input?: unknown }).input,
  ) as { todos?: unknown } | null;
  if (!rec) return null;
  if (!Array.isArray(rec.todos)) return null;
  const out: PlanItem[] = [];
  for (const t of rec.todos) {
    if (!t || typeof t !== "object") continue;
    const r = t as { content?: unknown; status?: unknown; activeForm?: unknown };
    const title =
      typeof r.content === "string"
        ? r.content
        : typeof r.activeForm === "string"
          ? r.activeForm
          : null;
    if (!title) continue;
    const status: PlanItemStatus =
      r.status === "completed"
        ? "completed"
        : r.status === "in_progress"
          ? "in_progress"
          : "pending";
    out.push({ status, title });
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse the markdown-checklist `task_list` tool call. Same format as the
 * existing TaskListCard so the two surfaces stay aligned.
 */
function parseTaskList(tc: AgentToolCall): PlanItem[] | null {
  const content = tc.fullContent ?? tc.summary ?? "";
  if (!content.trim()) return null;
  const lines = content.split("\n");
  const out: PlanItem[] = [];
  for (const raw of lines) {
    const m = raw.match(/^\s*-\s*\[(.)\]\s*(.+?)\s*$/);
    if (!m) continue;
    const marker = m[1].toLowerCase();
    const title = m[2];
    const status: PlanItemStatus =
      marker === "x"
        ? "completed"
        : marker === "~"
          ? "in_progress"
          : "pending";
    out.push({ status, title });
  }
  return out.length > 0 ? out : null;
}

/**
 * Walk a conversation backward looking for the most recent plan-bearing
 * tool call. Anthropic's TodoWrite wins over the markdown task_list — both
 * emit in roughly the same conceptual position in the agent's reasoning
 * loop, but TodoWrite's structured payload is richer.
 *
 * v3: prefer the structured plan-block snapshot from agentPlanStore over
 * re-parsing tool calls. Falls back to tool-call parsing for older sessions
 * / providers that don't emit plan_block yet.
 */
function latestPlan(
  conversation: AgentConversation,
  storedPlan: AgentPlanItem[] | undefined,
): PlanItem[] | null {
  if (storedPlan && storedPlan.length > 0) {
    return storedPlan.map((p) => ({
      status: p.status,
      title: p.activeForm ?? p.content,
    }));
  }
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const msg = conversation.messages[i];
    if (!msg.toolCalls) continue;
    for (let j = msg.toolCalls.length - 1; j >= 0; j--) {
      const tc = msg.toolCalls[j];
      if (tc.name === "TodoWrite") {
        const parsed = parseTodoWrite(tc);
        if (parsed) return parsed;
      }
      if (tc.name === "task_list") {
        const parsed = parseTaskList(tc);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

function StatusIcon({ status }: { status: PlanItemStatus }) {
  if (status === "completed")
    return <CheckSquare size={11} className="text-accent-green shrink-0" />;
  if (status === "in_progress")
    return (
      <Spinner size={11} className="text-accent-blue shrink-0" />
    );
  return <Square size={11} className="text-text-muted shrink-0" />;
}

function rowClass(status: PlanItemStatus): string {
  if (status === "completed")
    return "text-accent-green line-through opacity-80";
  if (status === "in_progress") return "text-accent-blue";
  return "text-text-secondary";
}

interface PlanPanelProps {
  conversation: AgentConversation;
}

/**
 * Always-visible plan / todo panel docked above the chat scroll. Surfaces
 * the agent's latest TodoWrite (Anthropic SDK) or task_list (markdown)
 * checklist so users can steer mid-task without scrolling back through
 * the transcript to find the plan. Sister to the inline TaskListCard which
 * still renders the same data within the message stream.
 *
 * Renders nothing when no plan-bearing tool call exists yet.
 *
 * B4 (wave 2b): this used to be mounted TWICE — here, inline above the chat
 * scroll, AND as a right-dock "Plan" panel. The dock copy is gone; the plan is
 * part of the conversation, not a filing-cabinet tab beside it.
 */
export function PlanPanel({ conversation }: PlanPanelProps) {
  const storedPlan = useAgentPlanStore((s) => s.plan.get(conversation.id));
  const planApproved = useAgentPlanStore(
    (s) => s.planApproved.get(conversation.id) ?? false,
  );
  const items = useMemo(
    () => latestPlan(conversation, storedPlan),
    [conversation, storedPlan],
  );
  const [collapsed, setCollapsed] = useState(false);
  const createApiConversation = useAgentTaskStore(
    (s) => s.createApiConversation,
  );
  const selectConversation = useAgentTaskStore((s) => s.selectConversation);
  const setParentConversation = useAgentTaskStore(
    (s) => s.setParentConversation,
  );

  // B8 — executor auth probe for the "Hand off to OpenAI" button. Only
  // meaningful when this conversation is the one authoring the plan (the
  // executor consumes plans, it can't hand off to itself). Live-refreshes on
  // `provider-auth:changed` so a key added in Settings enables the button
  // without a reload.
  //
  // The executor was `api-openai-codex` (Codex `exec` on a ChatGPT
  // subscription) until that row was removed in 2026-07; it is now the
  // OpenAI Agents SDK row, which reaches the same API with an API key and
  // additionally honours per-tool approvals.
  // The handoff exists when THIS session is the one that produces structured
  // plans — the executor consumes a plan, it does not author one. That is
  // exactly `structuredPlans`, so the control reads from the capability
  // descriptor instead of naming provider ids (capability rule).
  const authorsStructuredPlans = capabilitiesFor(conversation).structuredPlans;
  const [handingOff, setHandingOff] = useState(false);
  // Credential the handoff button gates on — the OpenAI API key. Derived in
  // the component rather than at module scope so importing this file never
  // reaches into the agent-task store.
  const handoffAuthProvider = authProbeProvider(HANDOFF_EXECUTOR_AGENT);
  const fetchAuthStatus = useAuthStatusStore((s) => s.fetchStatus);
  const ensureAuthListener = useAuthStatusStore((s) => s.ensureListener);
  const executorAuth = useAuthStatusStore(
    (s) => s.entries[authStatusKey(handoffAuthProvider)]?.value,
  );
  const executorReady = executorAuth !== undefined && executorAuth !== "loading"
    ? executorAuth.status === "ready"
    : false;
  useEffect(() => {
    if (!authorsStructuredPlans) return;
    ensureAuthListener();
    void fetchAuthStatus(handoffAuthProvider);
  }, [authorsStructuredPlans, fetchAuthStatus, ensureAuthListener, handoffAuthProvider]);

  if (!items) return null;

  // The plan stays a "proposal" while plan mode is on and the user hasn't
  // approved it yet. Approval happens on the inline PlanModeApprovalMenu,
  // which calls agentPlanStore.approvePlan — flipping planApproved here and
  // lifting plan mode, so this derivation clears on approval.
  const awaitingPlanApproval = (conversation.planMode ?? false) && !planApproved;
  const handoffEligible = authorsStructuredPlans && items.length > 0;

  // D3 / P0-4: the handoff used to hard-code `sshTarget: null`, silently
  // turning a remote conversation into a LOCAL executor session pointed at a
  // path that only exists on the remote host. The sidecar does run over SSH,
  // so the honest fix is to INHERIT the parent's remote identity. The one case we
  // cannot honor is a deleted server record — port/key/auth-method/host
  // fingerprint are gone, and fabricating them would silently downgrade
  // host-key checking — so the button disables with the standard tooltip.
  const inheritedSsh = inheritSshTarget(conversation);
  const remoteParent = isRemoteConversation(conversation);
  const remoteTargetLost = remoteParent && inheritedSsh === null;

  async function handleHandoff(): Promise<void> {
    if (!conversation.model || remoteTargetLost) return;
    setHandingOff(true);
    try {
      const prompt = buildHandoffPrompt(conversation, storedPlan);
      const executorProvider = API_PROVIDERS.find(
        (p) => p.agentCli === HANDOFF_EXECUTOR_AGENT,
      );
      const executorModel = executorProvider?.models[0]?.value ?? "gpt-5.5";
      const newId = await createApiConversation({
        agent: HANDOFF_EXECUTOR_AGENT,
        projectPath: conversation.projectPath,
        model: executorModel,
        initialMessage: prompt,
        systemPromptOverride:
          "You are executing an approved plan from a planning agent. " +
          "Follow the plan step by step; do not re-plan unless blocked.",
        thinkingEnabled: false,
        planMode: false, // executing, not planning
        // Inherit the parent's SSH identity so the executor runs where the
        // plan was made (null for local conversations, as before).
        sshTarget: inheritedSsh,
        skipBackendStart: false,
        allowedTools: null, // full toolset
        memoryContextEnabled: false,
      });
      setParentConversation(newId, conversation.id);
      selectConversation(newId);
    } catch (e) {
      console.warn("Plan handoff failed:", e);
    } finally {
      setHandingOff(false);
    }
  }

  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of items) {
    if (t.status === "completed") completed++;
    else if (t.status === "in_progress") inProgress++;
    else pending++;
  }

  return (
    <div
      className={`shrink-0 border-b border-bg-border bg-bg-secondary ${
        awaitingPlanApproval ? "ring-1 ring-accent-amber/40" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover transition-colors"
        title="Toggle plan visibility"
      >
        <CheckSquare size={11} className="text-accent-green shrink-0" />
        <span className="text-meta uppercase tracking-wide font-semibold text-text-secondary">
          {awaitingPlanApproval ? "Plan (proposed)" : "Plan"}
        </span>
        <span className="text-meta text-text-secondary">
          {completed}/{items.length} done
          {inProgress > 0 ? ` · ${inProgress} in progress` : ""}
          {pending > 0 ? ` · ${pending} pending` : ""}
        </span>
        <span className="ml-auto text-text-muted">
          <ChevronDown
            size={11}
            className={`transition-transform ${collapsed ? "" : "rotate-180"}`}
          />
        </span>
      </button>
      {!collapsed && (
        <ul className="px-3 pb-2 pt-0 space-y-0.5">
          {items.map((t, i) => (
            <li
              key={`${i}-${t.title}`}
              className={`flex items-center gap-1.5 text-ui leading-snug ${
                awaitingPlanApproval ? "text-text-muted" : rowClass(t.status)
              }`}
            >
              <StatusIcon status={t.status} />
              <span className="truncate" title={t.title}>
                {t.title}
              </span>
            </li>
          ))}
        </ul>
      )}
      {awaitingPlanApproval && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-bg-border">
          <span className="text-meta text-text-muted flex-1">
            Plan is a proposal — approve it inline where the plan ends.
          </span>
          {handoffEligible && (
            <Tooltip
              content={
                remoteTargetLost
                  ? `Hand off — ${REMOTE_UNSUPPORTED_TOOLTIP} (this conversation's SSH server record no longer exists, so its remote identity cannot be inherited)`
                  : !executorReady
                    ? "OpenAI API key required — add it in Settings → API Keys"
                    : remoteParent
                      ? `Hand the plan off to a fresh OpenAI executor conversation on ${conversation.sshTarget?.host}`
                      : "Hand the plan off to a fresh OpenAI executor conversation"
              }
            >
              <button
                type="button"
                onClick={() => void handleHandoff()}
                disabled={!executorReady || handingOff || remoteTargetLost}
                aria-disabled={!executorReady || handingOff || remoteTargetLost}
                className="flex items-center gap-1 text-ui px-2 py-0.5 rounded border border-accent-blue/40 text-accent-blue hover:bg-accent-blue/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send size={11} /> {handingOff ? "Handing off…" : "Hand off to OpenAI"}
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
