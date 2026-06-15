import type {
  AgentConversation,
  AgentPlanItem,
} from "@/types/agent-conversation";
import type { SpecRecord } from "@/stores/agentPlanStore";

/** Soft cap on the distillation prompt — well under the smallest Codex
 * context window. Codex doesn't need the parent conversation's full
 * history; the spec + plan is the contract that matters. */
const MAX_HANDOFF_BYTES = 12_000;

/** Tail length for the parent's last assistant turn — a paragraph is
 * usually enough context to anchor what was discussed. */
const ASSISTANT_TAIL_BYTES = 2_000;

/**
 * Walk the conversation backward to find the most recent assistant
 * message that has actual text content (skip pure tool-call turns).
 */
function lastAssistantMessage(conv: AgentConversation): string | null {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === "assistant" && m.content.trim().length > 0) {
      return m.content;
    }
  }
  return null;
}

function lastUserMessage(conv: AgentConversation): string | null {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === "user" && m.content.trim().length > 0) {
      return m.content;
    }
  }
  return null;
}

/** Render a plan item as a markdown checkbox row matching what
 * PlanPanel shows. Uses [~] for in-progress to match the existing
 * task_list spec. */
function planItemMarkdown(items: AgentPlanItem[]): string {
  return items
    .map((it) => {
      const marker =
        it.status === "completed"
          ? "x"
          : it.status === "in_progress"
            ? "~"
            : " ";
      return `- [${marker}] ${it.activeForm ?? it.content}`;
    })
    .join("\n");
}

/**
 * B8 — build the prompt that seeds a fresh Codex conversation when the
 * user clicks "Hand off to Codex →" on the parent's PlanPanel. The goal
 * is to give Codex the SPEC + APPROVED PLAN (the user's contract) plus
 * a brief discussion summary, but NOT the parent's full message history
 * — Codex's smaller context budget rewards distillation, and the spec
 * is the canonical statement of intent.
 *
 * Spec + plan are passed in (from agentPlanStore) since they no longer
 * live on the conversation object.
 */
export function buildHandoffPrompt(
  parent: AgentConversation,
  spec: SpecRecord | undefined,
  plan: AgentPlanItem[] | undefined,
): string {
  const sections: string[] = [];

  sections.push(
    "You are taking over execution from a planning agent in PacketADE. " +
      "The plan below was approved by the user. Execute it step by step; " +
      "do not re-plan unless blocked.",
  );

  if (spec && spec.status === "approved" && spec.criteria.length > 0) {
    const bullets = spec.criteria
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");
    sections.push(`## Spec (locked by user)\n\n${bullets}`);
  } else if (spec && spec.criteria.length > 0) {
    const bullets = spec.criteria.map((c) => `- ${c}`).join("\n");
    sections.push(
      `## Spec (draft — not yet locked, treat as guidance)\n\n${bullets}`,
    );
  }

  if (plan && plan.length > 0) {
    sections.push(`## Approved plan\n\n${planItemMarkdown(plan)}`);
  }

  // Brief discussion summary: last user prompt + tail of last assistant.
  const lastUser = lastUserMessage(parent);
  const lastAssistant = lastAssistantMessage(parent);
  if (lastUser || lastAssistant) {
    const parts: string[] = [];
    if (lastUser) parts.push(`### Latest user request\n\n${lastUser}`);
    if (lastAssistant) {
      const tail =
        lastAssistant.length > ASSISTANT_TAIL_BYTES
          ? `…${lastAssistant.slice(-ASSISTANT_TAIL_BYTES)}`
          : lastAssistant;
      parts.push(`### Planner's last reply\n\n${tail}`);
    }
    sections.push(`## Discussion summary\n\n${parts.join("\n\n")}`);
  }

  sections.push(
    `Project root: \`${parent.projectPath}\`. When done, summarize what you executed vs. the plan.`,
  );

  const joined = sections.join("\n\n---\n\n");
  if (joined.length <= MAX_HANDOFF_BYTES) return joined;
  // Truncate from the end of the discussion summary — keep the spec +
  // plan intact since those are the load-bearing parts.
  return `${joined.slice(0, MAX_HANDOFF_BYTES)}\n\n…(truncated to fit context)`;
}
