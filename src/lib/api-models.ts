import type { AgentCli } from "@/stores/agentTaskStore";
import { getModelContextWindow } from "@/lib/modelContext";

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
   * USD price per 1M tokens (input / output). conversationCost.ts owns the
   * authoritative rate table but intentionally keeps it private, so the
   * subset the composer needs is mirrored in `MODEL_PRICING` below.
   */
  pricing?: { input: number; output: number };
}

export interface ApiProviderInfo {
  id: string;
  agentCli: AgentCli;
  name: string;
  models: ApiModel[];
  needsKey: boolean;
}

export const API_PROVIDERS: ApiProviderInfo[] = [
  {
    id: "anthropic-oauth",
    agentCli: "api-claude-oauth",
    name: "Anthropic (Subscription)",
    needsKey: false,
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
  {
    id: "openai-codex",
    agentCli: "api-openai-codex",
    name: "OpenAI (ChatGPT Plus/Pro)",
    needsKey: false,
    // NOTE: gpt-5-codex is NOT available on a ChatGPT (Plus/Pro) account —
    // Codex returns 400 "model is not supported when using Codex with a
    // ChatGPT account". It's API-key-only, so it must not appear here. The
    // autonomy win for this provider comes from the harness + higher iteration
    // cap, not the model.
    models: [
      { label: "GPT-5.5 (default)", value: "gpt-5.5" },
      { label: "GPT-5", value: "gpt-5" },
      { label: "o4-mini", value: "o4-mini" },
    ],
  },
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
    id: "minimax-api",
    agentCli: "api-minimax-api",
    name: "MiniMax (API)",
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
];

/**
 * USD price per 1M tokens (input / output), keyed by the EXACT model `value`
 * strings used above so no key-normalization is needed at lookup time.
 *
 * These mirror the authoritative rates in conversationCost.ts, which owns the
 * table but deliberately does not export it (and is out of this lane to
 * change). Kept as a focused subset — only the composer's known models — so
 * the pickers can surface price without reaching into that private table.
 * Models without an entry (e.g. openrouter/auto, local Ollama) stay unpriced.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 15, output: 75 },
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-opus-4-6-20250415": { input: 15, output: 75 },
  "claude-sonnet-4-6-20250414": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "gpt-5.5": { input: 5, output: 15 },
  "gpt-5": { input: 5, output: 15 },
  "chatgpt-5.4": { input: 5, output: 15 },
  "gpt-4o": { input: 2.5, output: 10 },
  o3: { input: 15, output: 60 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "MiniMax-M3": { input: 0.3, output: 1.2 },
  "MiniMax-M2.5": { input: 0.3, output: 1.2 },
  "MiniMax-M2": { input: 0.3, output: 1.2 },
  "anthropic/claude-opus-4-8": { input: 15, output: 75 },
  "anthropic/claude-opus-4-7": { input: 15, output: 75 },
  "anthropic/claude-opus-4-6": { input: 15, output: 75 },
  "anthropic/claude-sonnet-4-6": { input: 3, output: 15 },
  "openai/gpt-5.5": { input: 5, output: 15 },
  "openai/chatgpt-5.4": { input: 5, output: 15 },
  "google/gemini-2.5-pro": { input: 1.25, output: 10 },
  "meta-llama/llama-4-maverick": { input: 0.2, output: 0.6 },
};

// Populate context-window + pricing metadata for every known model, sourcing
// context from the shared modelContext helper (imported, not duplicated) and
// price from the MODEL_PRICING subset above.
for (const provider of API_PROVIDERS) {
  for (const model of provider.models) {
    model.contextWindow = getModelContextWindow(model.value);
    const rates = MODEL_PRICING[model.value];
    if (rates) model.pricing = rates;
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
