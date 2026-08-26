import type { AgentCli } from "@/stores/agentTaskStore";
import { getModelContextWindow } from "@/lib/modelContext";
import { getModelRates } from "@/lib/conversationCost";

export interface ApiModel {
  label: string;
  value: string;
  /**
   * Total context-window size in tokens. Sourced from the shared
   * `getModelContextWindow` helper (see modelContext.ts) — not duplicated —
   * and populated for every known model below.
   */
  contextWindow?: number;
  /**
   * USD price per 1M tokens (input / output). Sourced from
   * conversationCost.ts's `getModelRates`, which reads the ONE pricing table
   * (`shared/model-pricing.json`, shared with the Rust engine) — not
   * duplicated here.
   */
  pricing?: { input: number; output: number };
}

export interface ApiProviderInfo {
  id: string;
  agentCli: AgentCli;
  name: string;
  models: ApiModel[];
  needsKey: boolean;
  /**
   * P1-S4: whether this provider's adapter can honor a per-tool approval
   * round-trip. Undefined is treated as `true` (approval-capable). When
   * `false`, the mode pickers filter to only the postures the adapter can
   * actually enforce (see `agentModeChipUtils.modesForApprovals`).
   *
   * No catalog row sets this today. It was introduced for the OpenAI Codex
   * `exec` adapter, which mapped EVERY PermissionMode to a sandbox+`never`
   * tuple because its stdin was closed; that row was removed in 2026-07. The
   * flag and its plumbing are kept because "this adapter cannot pause for
   * approval" is a real property a future adapter may have, and discovering
   * it again the hard way is worse than carrying an unused boolean.
   */
  supportsApprovals?: boolean;
}

export const API_PROVIDERS: ApiProviderInfo[] = [
  {
    // Historical id — the row is the Claude Agent SDK, which since 2026-07
    // authenticates with the `api-key-anthropic` keyring entry instead of a
    // Claude.ai subscription login. Anthropic's legal-and-compliance page
    // directs Agent SDK developers to "use the API key authentication
    // methods described in the Quickstart instead", so the SDK — and the
    // capabilities only it provides (targeted edit tool, structured plan
    // blocks, real permission modes, MCP, Claude Code settings sourcing) —
    // stays; only the credential changed. The ids are unchanged because
    // persisted conversations store `api-claude-oauth` / `claude-oauth` and
    // resume with them verbatim.
    id: "anthropic-oauth",
    agentCli: "api-claude-oauth",
    name: "Claude Agent SDK (API)",
    needsKey: true,
    models: [
      { label: "Claude Opus 4.8", value: "claude-opus-4-8" },
      { label: "Claude Opus 4.7", value: "claude-opus-4-7" },
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
      { label: "Claude Haiku 4.5", value: "claude-haiku-4-5" },
    ],
  },
  {
    id: "anthropic",
    agentCli: "api-claude",
    name: "Claude (API)",
    needsKey: true,
    models: [
      { label: "Claude Opus 4.8", value: "claude-opus-4-8" },
      { label: "Claude Opus 4.7", value: "claude-opus-4-7" },
      { label: "Claude Opus 4.6", value: "claude-opus-4-6-20250415" },
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6-20250414" },
      { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001" },
    ],
  },
  // REMOVED 2026-07: `openai-codex` / `api-openai-codex`, the
  // "OpenAI (ChatGPT Plus/Pro)" row that drove `codex exec` as a subprocess on
  // a ChatGPT subscription login. Without a subscription it bought nothing over
  // the `openai-agents` row below, which reaches the same OpenAI API with the
  // same API key and — unlike Codex `exec` — can service a per-tool approval
  // round-trip. Persisted conversations on the id stay readable; see
  // `RETIRED_API_AGENTS` in `agentTaskStore.ts`.
  {
    id: "openai",
    agentCli: "api-openai",
    name: "OpenAI (API)",
    needsKey: true,
    models: [
      { label: "GPT-5.5 (default)", value: "gpt-5.5" },
      { label: "ChatGPT 5.4", value: "chatgpt-5.4" },
      { label: "GPT-4o", value: "gpt-4o" },
      { label: "o3", value: "o3" },
      { label: "o4-mini", value: "o4-mini" },
    ],
  },
  {
    id: "openai-agents",
    agentCli: "api-openai-agents",
    name: "OpenAI Agents SDK (API)",
    needsKey: true,
    models: [
      { label: "GPT-5.5 (default)", value: "gpt-5.5" },
      { label: "ChatGPT 5.4", value: "chatgpt-5.4" },
      { label: "GPT-4o", value: "gpt-4o" },
      { label: "o3", value: "o3" },
      { label: "o4-mini", value: "o4-mini" },
    ],
  },
  {
    id: "minimax",
    agentCli: "api-minimax",
    name: "MiniMax (Token Plan)",
    needsKey: true,
    models: [
      { label: "M3", value: "MiniMax-M3" },
      { label: "M2.5", value: "MiniMax-M2.5" },
      { label: "M2", value: "MiniMax-M2" },
    ],
  },
  {
    id: "openrouter",
    agentCli: "api-openrouter",
    name: "OpenRouter",
    needsKey: true,
    models: [
      { label: "Auto (best available)", value: "openrouter/auto" },
      { label: "Claude Opus 4.8", value: "anthropic/claude-opus-4-8" },
      { label: "Claude Opus 4.7", value: "anthropic/claude-opus-4-7" },
      { label: "Claude Opus 4.6", value: "anthropic/claude-opus-4-6" },
      { label: "Claude Sonnet 4.6", value: "anthropic/claude-sonnet-4-6" },
      { label: "GPT-5.5", value: "openai/gpt-5.5" },
      { label: "ChatGPT 5.4", value: "openai/chatgpt-5.4" },
      { label: "Gemini 2.5 Pro", value: "google/gemini-2.5-pro" },
      { label: "Llama 4 Maverick", value: "meta-llama/llama-4-maverick" },
    ],
  },
  {
    id: "ollama",
    agentCli: "api-ollama",
    name: "Ollama (Local)",
    needsKey: false,
    models: [
      { label: "Llama 3.3 70B", value: "llama3.3:70b" },
      { label: "Qwen 3 32B", value: "qwen3:32b" },
      { label: "DeepSeek Coder V2", value: "deepseek-coder-v2" },
      { label: "CodeLlama 34B", value: "codellama:34b" },
    ],
  },
  {
    // The sibling PacketCode TUI, driven over Agent Client Protocol as a local
    // subprocess. `needsKey: false` for the same reason as Ollama: the engine
    // owns its own provider credentials (its config + keyring), so PacketADE
    // never holds an API key for this row and the auth badge reflects engine
    // reachability rather than a keyring slot.
    //
    // `supportsApprovals: true` — ACP carries a real per-tool permission
    // round-trip (`session/request_permission`), so every PermissionMode the
    // mode pickers offer is genuinely enforceable here.
    //
    // The model list is SEEDED, not authoritative: the engine enumerates its
    // live models over `_packetcode/models/list` at session time. These three
    // exist so the picker renders something before the engine has been asked,
    // mirroring how the Ollama row seeds common local tags ahead of
    // `list_ollama_models`. All three ids resolve in shared/model-pricing.json
    // and modelContext.ts, so cost/context surfaces stay honest.
    id: "packetcode-acp",
    agentCli: "api-packetcode",
    name: "PacketCode (ACP)",
    needsKey: false,
    supportsApprovals: true,
    models: [
      { label: "Claude Opus 4.8", value: "claude-opus-4-8" },
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
      { label: "GPT-5.5", value: "gpt-5.5" },
    ],
  },
];

// Populate context-window + pricing metadata for every known model, sourcing
// context from the shared modelContext helper and price from
// conversationCost.ts's getModelRates (→ shared/model-pricing.json) — both
// imported, neither duplicated.
// The zero-rate guard preserves prior behavior: Ollama/free models (rates of
// 0/0) stay unpriced rather than showing "$0/$0".
for (const provider of API_PROVIDERS) {
  for (const model of provider.models) {
    model.contextWindow = getModelContextWindow(model.value);
    const rates = getModelRates(model.value);
    if (rates && (rates.input > 0 || rates.output > 0)) model.pricing = rates;
  }
}

/** Get provider info by agent CLI identifier. */
export function getProviderForAgent(agent: AgentCli): ApiProviderInfo | undefined {
  return API_PROVIDERS.find((p) => p.agentCli === agent);
}

/** Get the default model for a provider. */
export function getDefaultModel(agent: AgentCli): string {
  const provider = getProviderForAgent(agent);
  return provider?.models[0]?.value ?? "";
}

/**
 * P1-S4: whether the given agent's adapter can honor a per-tool approval
 * round-trip. Providers with no catalog entry (e.g. PTY CLI agents, and
 * retired ids) and providers that omit the flag are treated as
 * approval-capable. No live row sets it `false`; see `supportsApprovals`.
 */
export function providerSupportsApprovals(agent: AgentCli): boolean {
  return getProviderForAgent(agent)?.supportsApprovals ?? true;
}

export type ModelSpeed = "fast" | "balanced" | "thorough";

/** Heuristic mapping of a model id to a Cursor-style speed label. */
export function getModelSpeed(modelId: string | undefined | null): ModelSpeed {
  if (!modelId) return "balanced";
  const id = modelId.toLowerCase();
  // Anthropic
  if (id.includes("haiku")) return "fast";
  if (id.includes("opus")) return "thorough";
  if (id.includes("sonnet")) return "balanced";
  // OpenAI
  if (id.includes("o3")) return "thorough";
  if (id.includes("o4-mini") || id.includes("4o-mini")) return "fast";
  if (id.includes("gpt-5.5") || id.includes("chatgpt-5.4") || id.includes("gpt-5-codex")) {
    return "balanced";
  }
  if (id.includes("gpt-4o") || id.includes("gpt-5")) return "balanced";
  // MiniMax
  if (id.includes("highspeed")) return "fast";
  if (id.includes("minimax")) return "balanced";
  // OpenRouter
  if (id.includes("auto")) return "balanced";
  // Gemini / Llama / Ollama — generally local or general-purpose
  if (id.includes("flash") || id.includes("mini")) return "fast";
  if (id.includes("70b") || id.includes("405b") || id.includes("32b")) return "thorough";
  return "balanced";
}

export const MODEL_SPEED_LABEL: Record<ModelSpeed, string> = {
  fast: "Fast",
  balanced: "Balanced",
  thorough: "Thorough",
};
