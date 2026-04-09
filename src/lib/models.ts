export interface ModelOption {
  label: string;
  value: string | null; // null = system default (no --model flag)
}

export const CLAUDE_MODELS: ModelOption[] = [
  { label: "System Default", value: null },
  { label: "Opus 4.6", value: "claude-opus-4-6-20250610" },
  { label: "Opus 4.5", value: "claude-opus-4-5-20250514" },
  { label: "Sonnet 4.5", value: "claude-sonnet-4-5-20250514" },
  { label: "Haiku 4.5", value: "claude-haiku-4-5-20250514" },
];

export const CODEX_MODELS: ModelOption[] = [
  { label: "System Default", value: null },
  { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
  { label: "GPT-5.2 Codex", value: "gpt-5.2-codex" },
  { label: "GPT-5.1 Codex", value: "gpt-5.1-codex" },
  { label: "Codex Mini", value: "codex-mini-latest" },
];

export const GEMINI_MODELS: ModelOption[] = [
  { label: "System Default", value: null },
  { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro" },
  { label: "Gemini 2.5 Flash", value: "gemini-2.5-flash" },
  { label: "Gemini 2.0 Pro", value: "gemini-2.0-pro" },
  { label: "Gemini 2.0 Flash", value: "gemini-2.0-flash" },
];

export const OPENCODE_MODELS: ModelOption[] = [
  { label: "System Default", value: null },
  { label: "Claude Opus 4.6", value: "claude-opus-4-6" },
  { label: "Claude Sonnet 4.5", value: "claude-sonnet-4-5" },
  { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
  { label: "Gemini 2.5 Pro", value: "gemini-2.5-pro" },
];

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
