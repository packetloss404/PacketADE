import { useEffect, useMemo, useState } from "react";
import {
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pause,
  Play,
  Send,
  Square,
  Target,
  X,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { useGoalStore } from "@/stores/goalStore";
import { API_PROVIDERS } from "@/lib/api-models";
import { buildHandoffPrompt } from "@/lib/conversationHandoff";
import {
  getProviderAuthStatus,
  type ProviderAuthStatus,
} from "@/lib/tauri";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentConversation,
  AgentPlanItem,
  AgentToolCall,
} from "@/types/agent-conversation";

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
  const raw = (tc as AgentToolCall & { input?: unknown }).input;
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as { todos?: unknown };
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
      <Loader2 size={11} className="text-accent-blue shrink-0 animate-spin" />
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
 */
export function PlanPanel({ conversation }: PlanPanelProps) {
  const storedPlan = useAgentPlanStore((s) => s.plan.get(conversation.id));
  const specStage = useAgentPlanStore((s) => s.specStage.get(conversation.id));
  const planApproved = useAgentPlanStore(
    (s) => s.planApproved.get(conversation.id) ?? false,
  );
  const spec = useAgentPlanStore((s) => s.spec.get(conversation.id));
  const items = useMemo(
    () => latestPlan(conversation, storedPlan),
    [conversation, storedPlan],
  );
  const [collapsed, setCollapsed] = useState(false);
  const approvePlan = useAgentPlanStore((s) => s.approvePlan);
  const createApiConversation = useAgentTaskStore(
    (s) => s.createApiConversation,
  );
  const selectConversation = useAgentTaskStore((s) => s.selectConversation);
  const setParentConversation = useAgentTaskStore(
    (s) => s.setParentConversation,
  );

  // B8 — Codex auth probe for the "Hand off to Codex" button. Only
  // meaningful when the parent conversation is a Claude one (Codex
  // can't hand off to itself). Live-refreshes on `provider-auth:changed`
  // so a `codex login` finishing in another window enables the button.
  const isClaudeParent =
    conversation.agent === "api-claude" ||
    conversation.agent === "api-claude-oauth";
  const [codexReady, setCodexReady] = useState(false);
  const [handingOff, setHandingOff] = useState(false);
  useEffect(() => {
    if (!isClaudeParent) return;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    const refresh = () => {
      getProviderAuthStatus("openai-codex")
        .then((s) => {
          if (!cancelled) setCodexReady(s.status === "ready");
        })
        .catch(() => {
          if (!cancelled) setCodexReady(false);
        });
    };
    refresh();
    listen<{ provider: string; status: ProviderAuthStatus }>(
      "provider-auth:changed",
      (event) => {
        if (event.payload.provider !== "openai-codex") return;
        setCodexReady(event.payload.status.status === "ready");
      },
    )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) =>
        console.warn("[PlanPanel.listenSidecarStatus] subscribe failed:", err),
      );
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isClaudeParent]);

  // B5: bound goal (when this conversation has been promoted via /goal).
  // Snapshot the conversation's plan into the goal whenever it changes
  // so the persisted goal stays current for cross-conversation
  // continuation.
  const boundGoal = useGoalStore((s) =>
    s.getGoalForConversation(conversation.id),
  );
  const syncChecklistFromConversation = useGoalStore(
    (s) => s.syncChecklistFromConversation,
  );
  const pauseGoal = useGoalStore((s) => s.pauseGoal);
  const resumeGoal = useGoalStore((s) => s.resumeGoal);
  const completeGoal = useGoalStore((s) => s.completeGoal);
  useEffect(() => {
    if (!boundGoal || !storedPlan) return;
    syncChecklistFromConversation(boundGoal.id, storedPlan);
  }, [boundGoal, storedPlan, syncChecklistFromConversation]);

  if (!items) return null;

  const awaitingPlanApproval = specStage === "plan" && !planApproved;
  const handoffEligible =
    isClaudeParent && (items.length > 0 || (spec?.criteria.length ?? 0) > 0);

  async function handleHandoff(): Promise<void> {
    if (!conversation.model) return;
    setHandingOff(true);
    try {
      const prompt = buildHandoffPrompt(conversation, spec, storedPlan);
      const codexProvider = API_PROVIDERS.find(
        (p) => p.agentCli === "api-openai-codex",
      );
      const codexModel = codexProvider?.models[0]?.value ?? "gpt-5-codex";
      const newId = await createApiConversation(
        "api-openai-codex",
        conversation.projectPath,
        codexModel,
        prompt,
        "You are executing an approved plan from a planning agent. " +
          "Follow the plan step by step; do not re-plan unless blocked.",
        false, // thinkingEnabled
        false, // planMode (executing, not planning)
        null, // sshTarget
        undefined,
        false,
        null, // allowedTools — full toolset
        false, // memoryContextEnabled
      );
      setParentConversation(newId, conversation.id);
      selectConversation(newId);
    } catch (e) {
      console.warn("Codex handoff failed:", e);
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
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover/40 transition-colors"
        title="Toggle plan visibility"
      >
        <CheckSquare size={11} className="text-accent-green shrink-0" />
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          {awaitingPlanApproval ? "Plan (proposed)" : "Plan"}
        </span>
        <span className="text-[10px] text-text-secondary">
          {completed}/{items.length} done
          {inProgress > 0 ? ` · ${inProgress} in progress` : ""}
          {pending > 0 ? ` · ${pending} pending` : ""}
        </span>
        <span className="ml-auto text-text-muted">
          {collapsed ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
        </span>
      </button>
      {!collapsed && (
        <ul className="px-3 pb-2 pt-0 space-y-0.5">
          {items.map((t, i) => (
            <li
              key={`${i}-${t.title}`}
              className={`flex items-center gap-1.5 text-[11px] leading-snug ${
                awaitingPlanApproval ? "text-text-muted" : rowClass(t.status)
              }`}
            >
              <StatusIcon status={t.status} />
              <span className="truncate">{t.title}</span>
            </li>
          ))}
        </ul>
      )}
      {awaitingPlanApproval && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-bg-border">
          <span className="text-[10px] text-text-muted flex-1">
            Plan is a proposal — approve to lift plan-mode and execute.
          </span>
          {handoffEligible && (
            <button
              type="button"
              onClick={() => void handleHandoff()}
              disabled={!codexReady || handingOff}
              title={
                !codexReady
                  ? "Codex login required (run `codex login` or sign in via the provider dropdown)"
                  : "Hand the approved plan off to a fresh Codex conversation for execution"
              }
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-accent-blue/40 text-accent-blue hover:bg-accent-blue/10 disabled:opacity-40"
            >
              <Send size={11} /> {handingOff ? "Handing off…" : "Hand off to Codex"}
            </button>
          )}
          <button
            type="button"
            onClick={() => approvePlan(conversation.id)}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
          >
            <Play size={11} /> Approve & execute
          </button>
        </div>
      )}
      {/* B5 — goal binding row. Renders when this conversation has been
          promoted via /goal. Pause = surface as paused in MissionsView
          but keep the conversation running. Complete = mark done.
          Cancel/delete left to a separate confirm flow in MissionsView. */}
      {boundGoal && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-accent-blue/30 bg-accent-blue/5">
          <Target size={11} className="text-accent-blue" />
          <span className="text-[10px] text-text-secondary flex-1 truncate">
            Bound goal:{" "}
            <span className="text-accent-blue font-medium">
              {boundGoal.title}
            </span>{" "}
            · status{" "}
            <span className="font-mono">{boundGoal.status}</span>
          </span>
          {boundGoal.status === "active" && (
            <button
              type="button"
              onClick={() => pauseGoal(boundGoal.id)}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-bg-border text-text-muted hover:text-accent-amber"
              title="Mark goal paused (conversation keeps running; MissionsView shows it as paused)"
            >
              <Pause size={10} /> Pause
            </button>
          )}
          {boundGoal.status === "paused" && (
            <button
              type="button"
              onClick={() => resumeGoal(boundGoal.id)}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
            >
              <Play size={10} /> Resume
            </button>
          )}
          {(boundGoal.status === "active" ||
            boundGoal.status === "paused") && (
            <button
              type="button"
              onClick={() => completeGoal(boundGoal.id)}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
            >
              <X size={10} /> Complete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
