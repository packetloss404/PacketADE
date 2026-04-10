export interface ModelOption {
  label: string;
  value: string | null; // null = system default (no --model flag)
}

export const CLAUDE_MODELS: ModelOption[] = [
  { label: "System Default", value: null },
  { label: "Opus 4.6", value: "claude-opus-4-6-20250610" },
  { label: "Sonnet 4.5", value: "claude-sonnet-4-5-20250514" },
  { label: "Haiku 4.5", value: "claude-haiku-4-5-20250514" },
];

export const CODEX_MODELS: ModelOption[] = [
  { label: "System Default", value: null },
  { label: "GPT-5.4", value: "gpt-5.4" },
  { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
];

export const GEMINI_MODELS: ModelOption[] = [
  { label: "System Default", value: null },
  { label: "Gemini 3.1 Pro", value: "gemini-3.1-pro" },
  { label: "Gemini 3 Flash", value: "gemini-3-flash" },
];

export const OPENCODE_MODELS: ModelOption[] = [];

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
    default:
      return [{ label: "System Default", value: null }];
  }
}
