import type { AgentCli } from "@/stores/agentTaskStore";

export interface ApiModel {
  label: string;
  value: string;
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
    id: "anthropic",
    agentCli: "api-claude",
    name: "Claude (API)",
    needsKey: true,
    models: [
      { label: "Claude Opus 4.7", value: "claude-opus-4-7" },
      { label: "Claude Opus 4.6", value: "claude-opus-4-6-20250415" },
      { label: "Claude Sonnet 4.6", value: "claude-sonnet-4-6-20250414" },
      { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001" },
    ],
  },
  {
    id: "openai",
    agentCli: "api-openai",
    name: "OpenAI (API)",
    needsKey: true,
    models: [
      { label: "ChatGPT 5.4", value: "chatgpt-5.4" },
      { label: "GPT-4o", value: "gpt-4o" },
      { label: "o3", value: "o3" },
      { label: "o4-mini", value: "o4-mini" },
    ],
  },
  {
    id: "minimax",
    agentCli: "api-minimax",
    name: "MiniMax (API)",
    needsKey: true,
    models: [
      { label: "M2.7 (high speed)", value: "MiniMax-M2.7-highspeed" },
      { label: "M2.7", value: "MiniMax-M2.7" },
    ],
  },
  {
    id: "openrouter",
    agentCli: "api-openrouter",
    name: "OpenRouter",
    needsKey: true,
    models: [
      { label: "Auto (best available)", value: "openrouter/auto" },
      { label: "Claude Opus 4.7", value: "anthropic/claude-opus-4-7" },
      { label: "Claude Opus 4.6", value: "anthropic/claude-opus-4-6" },
      { label: "Claude Sonnet 4.6", value: "anthropic/claude-sonnet-4-6" },
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

/** Get provider info by agent CLI identifier. */
export function getProviderForAgent(agent: AgentCli): ApiProviderInfo | undefined {
  return API_PROVIDERS.find((p) => p.agentCli === agent);
}

/** Get the default model for a provider. */
export function getDefaultModel(agent: AgentCli): string {
  const provider = getProviderForAgent(agent);
  return provider?.models[0]?.value ?? "";
}
