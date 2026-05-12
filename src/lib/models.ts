export interface ModelOption {
  label: string;
  value: string | null; // null = system default (no --model flag)
}

// Use un-dated aliases so PacketADE always picks the latest version of each tier.
export const CLAUDE_MODELS: ModelOption[] = [
  { label: "Opus 4.7", value: "claude-opus-4-7" },
  { label: "Opus 4.6", value: "claude-opus-4-6" },
  { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
  { label: "Haiku 4.5", value: "claude-haiku-4-5" },
];

export const CODEX_MODELS: ModelOption[] = [
  { label: "GPT-5.5", value: "gpt-5.5" },
  { label: "GPT-5.4", value: "gpt-5.4" },
  { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
];

export const GEMINI_MODELS: ModelOption[] = [
  { label: "Gemini 3.1 Pro", value: "gemini-3.1-pro" },
  { label: "Gemini 3 Flash", value: "gemini-3-flash" },
];

export type EffortLevel = "low" | "medium" | "high";

export const EFFORT_LEVELS: { label: string; value: EffortLevel }[] = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
];

export const OPENCODE_MODELS: ModelOption[] = [];

// PacketCode reads its default from `~/.packetcode/config.toml`; no curated
// list yet — the CLI accepts any provider-specific model name via --model.
export const PACKETCODE_MODELS: ModelOption[] = [];

/** Return the model list appropriate for a given agent */
export function getModelsForAgent(agentConfigId: string): ModelOption[] {
  switch (agentConfigId) {
    case "claude-code":
      return CLAUDE_MODELS;
    case "codex":
      return CODEX_MODELS;
    case "gemini":
      return GEMINI_MODELS;
    case "opencode":
      return OPENCODE_MODELS;
    case "packetcode":
      return PACKETCODE_MODELS;
    default:
      return [{ label: "System Default", value: null }];
  }
}
