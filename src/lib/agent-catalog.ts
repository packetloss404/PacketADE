/**
 * Merged agent catalog (tile program, P3-S4).
 *
 * A thin static READ-LAYER registry that joins the two existing sources of
 * truth — `lib/api-models.ts` (API "Chat agent" providers) and
 * `lib/cli-catalog.ts` / `types/workspace` (the CLI "Terminal" slots) — under a
 * single capability vocabulary. WA2's Workspace `AddSessionPicker` consumes
 * only the terminal half; compatibility draft tiles still use the chat lookup.
 * It NEVER mutates either source: `API_PROVIDERS`
 * and `CLI_CATALOG` stay the owners of models / install metadata. This module
 * only re-projects them behind the ruled capability flags
 * `{ face, supportsApprovals, supportsSsh, models[] }`.
 *
 * Capability language, never transport language (binding ruling): a "Chat agent"
 * is an API provider whose face is the chat tile; a "Terminal" is a PTY CLI
 * slot. The same vendor legitimately appears in both sections (e.g. Claude as a
 * Chat agent AND Claude Code as a Terminal) — the section headers disambiguate
 * search hits.
 */
import type { AgentCli } from "@/stores/agentTaskStore";
import { API_PROVIDERS, type ApiModel } from "@/lib/api-models";
import { CLI_CATALOG } from "@/lib/cli-catalog";
import type { WorkspaceAgentSlot } from "@/types/workspace";

/** A flattened API provider presented as a Chat-agent row. */
export interface ChatAgentEntry {
  section: "chat";
  agentCli: AgentCli;
  /** Concise picker display name (the chat "face"). */
  face: string;
  /** Default model label shown as the row subtext. */
  defaultModelLabel: string;
  /** Default model value handed to the draft tile. */
  defaultModel: string;
  /** P1-S4 (Codex honesty): whether the adapter can honor approval round-trips.
   *  Drives the capability-filtered mode set in the draft tile. */
  supportsApprovals: boolean;
  /** Whether this provider can run against a remote (SSH) execution context.
   *  Local-only runtimes (Ollama) are false. Informational for P3. */
  supportsSsh: boolean;
  /** The provider's models (from api-models — not duplicated). */
  models: ApiModel[];
}

/** A CLI slot presented as a Terminal row. */
export interface TerminalAgentEntry {
  section: "terminal";
  slot: WorkspaceAgentSlot;
  /** Picker display name. */
  face: string;
  /** Terminals inherit the workspace's SSH execution context unchanged. */
  supportsSsh: boolean;
}

/**
 * Concise chat "face" names keyed by agentCli. `api-models.ts` names some
 * providers by billing surface ("Anthropic (Subscription)"); the picker wants
 * the runtime face ("Claude OAuth") so search disambiguation reads naturally
 * ("cla" → Claude under Chat agents, Claude Code under Terminals).
 */
const CHAT_FACE: Partial<Record<AgentCli, string>> = {
  "api-claude-oauth": "Claude OAuth",
  "api-claude": "Claude API",
  "api-openai-codex": "Codex ChatGPT",
  "api-openai": "OpenAI",
  "api-openai-agents": "OpenAI Agents",
  "api-minimax": "MiniMax",
  "api-openrouter": "OpenRouter",
  "api-ollama": "Ollama",
};

/** Local-only chat runtimes cannot inherit an SSH execution context. */
const CHAT_LOCAL_ONLY: ReadonlySet<AgentCli> = new Set<AgentCli>(["api-ollama"]);

/**
 * The Chat-agent section: every API provider from `api-models.ts`, projected
 * under the capability flags. Order preserved from `API_PROVIDERS` so the
 * subscription faces (Claude OAuth, Codex ChatGPT) lead their vendor groups.
 */
export const CHAT_AGENTS: ChatAgentEntry[] = API_PROVIDERS.map((p) => ({
  section: "chat" as const,
  agentCli: p.agentCli,
  face: CHAT_FACE[p.agentCli] ?? p.name,
  defaultModelLabel: p.models[0]?.label ?? "",
  defaultModel: p.models[0]?.value ?? "",
  supportsApprovals: p.supportsApprovals ?? true,
  supportsSsh: !CHAT_LOCAL_ONLY.has(p.agentCli),
  models: p.models,
}));

/**
 * The six Terminal slots, in the historical WorkspaceView order. Faces come
 * from `cli-catalog.ts` where present (Claude Code, Codex CLI, …); the bare
 * `terminal` slot has no catalog entry and is named directly.
 */
const TERMINAL_SLOTS: WorkspaceAgentSlot[] = [
  "claude-code",
  "codex",
  "gemini",
  "opencode",
  "packetcode",
  "terminal",
];

/** cli-catalog ids that map onto a WorkspaceAgentSlot (same id). */
function terminalFace(slot: WorkspaceAgentSlot): string {
  if (slot === "terminal") return "Terminal";
  return CLI_CATALOG.find((e) => e.id === slot)?.name ?? slot;
}

export const TERMINAL_AGENTS: TerminalAgentEntry[] = TERMINAL_SLOTS.map((slot) => ({
  section: "terminal" as const,
  slot,
  face: terminalFace(slot),
  // A plain terminal and every CLI agent inherit the workspace SSH context.
  supportsSsh: true,
}));

/** Lookup a chat entry by agentCli. */
export function getChatAgent(agentCli: AgentCli): ChatAgentEntry | undefined {
  return CHAT_AGENTS.find((c) => c.agentCli === agentCli);
}
