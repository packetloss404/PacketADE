/**
 * CLI catalog metadata for PacketADE's Tier 1 CLI detection grid.
 *
 * Pure frontend metadata describing the coding-agent CLIs that PacketADE can
 * detect on the host PATH. The detection backend consumes `getCliBinaries()`
 * to probe for each binary; the UI consumes `CLI_CATALOG` directly to render
 * detection cards (icon, label, color, description).
 *
 * Ordering note: PacketCode (entry 6) is intentionally placed immediately
 * after OpenCode (entry 5) — PacketCode is the sibling terminal TUI to
 * PacketADE and the two are visually paired in the grid.
 */

export type CliBrandColor =
  | "amber"
  | "blue"
  | "green"
  | "purple"
  | "red"
  | "neutral";

export interface CliCatalogEntry {
  /** Stable id used as the detection + state key. */
  id: string;
  /** User-facing name. */
  name: string;
  /** Binary to detect on PATH. */
  binary: string;
  /** lucide-react icon name (string) — the consuming card resolves this. */
  iconName: string;
  /** Brand accent color token slug. */
  color: CliBrandColor;
  /** Short description shown when not installed. */
  description?: string;
  /** Stable one-line install command that runs in a workspace PTY pane.
   *  Cross-platform unless noted. Null/undefined = no install button. */
  installCommand?: string;
  /** External docs URL for install instructions when there's no scriptable command. */
  installDocsUrl?: string;
  /** True for CLIs we're tracking but don't yet support installing — surfaced
   *  as a "Coming Soon" badge when detection finds nothing. */
  comingSoon?: boolean;
  /** True when the CLI cannot be auto-discovered (in-development or
   *  highly-custom install path) — the card highlights the Browse-for-binary
   *  affordance instead of "not installed" copy. */
  browseRequired?: boolean;
}

export const CLI_CATALOG: CliCatalogEntry[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    binary: "claude",
    iconName: "Bot",
    color: "purple",
    description: "Anthropic's CLI coding agent",
    installCommand: "npm i -g @anthropic-ai/claude-code",
  },
  {
    id: "codex",
    name: "Codex CLI",
    binary: "codex",
    iconName: "Atom",
    color: "green",
    description: "OpenAI's terminal coding agent",
    installCommand: "npm i -g @openai/codex",
  },
  {
    id: "devin",
    name: "Devin for Terminal",
    binary: "devin",
    iconName: "Cpu",
    color: "neutral",
    description: "Cognition's autonomous coding agent",
    comingSoon: true,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    binary: "gemini",
    iconName: "Sparkles",
    color: "blue",
    description: "Google's CLI coding agent",
    installCommand: "npm i -g @google/gemini-cli",
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",
    iconName: "Hexagon",
    color: "green",
    description: "Open-source coding TUI",
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
  },
  {
    id: "packetcode",
    name: "PacketCode",
    binary: "packetcode",
    iconName: "Terminal",
    color: "amber",
    description: "PacketADE's sibling terminal coding TUI",
    browseRequired: true,
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    binary: "gh-copilot",
    iconName: "Github",
    color: "neutral",
    description: "GitHub's AI coding companion",
    installCommand: "gh extension install github/gh-copilot",
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    binary: "kimi",
    iconName: "Wand2",
    color: "blue",
    description: "Moonshot's coding CLI",
    comingSoon: true,
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    binary: "cursor-agent",
    iconName: "MousePointer2",
    color: "blue",
    description: "Cursor's terminal agent",
    comingSoon: true,
  },
  {
    id: "qwen",
    name: "Qwen Code",
    binary: "qwen",
    iconName: "BrainCircuit",
    color: "purple",
    description: "Alibaba's coding CLI",
    installCommand: "npm i -g @qwen-code/qwen-code",
  },
  {
    id: "qoder",
    name: "Qoder CLI",
    binary: "qoder",
    iconName: "Hexagon",
    color: "green",
    description: "Open-source coding CLI",
    installCommand: "npm i -g @qoder/qoder-cli",
  },
  {
    id: "mistral",
    name: "Mistral Vibe CLI",
    binary: "mistral",
    iconName: "Wind",
    color: "amber",
    description: "Mistral's coding CLI",
    comingSoon: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek TUI",
    binary: "deepseek",
    iconName: "Diamond",
    color: "blue",
    description: "DeepSeek's terminal coding TUI",
    comingSoon: true,
  },
];

/** Look up a catalog entry by stable id. */
export function getCliCatalogEntry(id: string): CliCatalogEntry | undefined {
  return CLI_CATALOG.find((entry) => entry.id === id);
}

/** Convenience accessor for the backend detector — pairs each id with its binary. */
export function getCliBinaries(): Array<{ id: string; binary: string }> {
  return CLI_CATALOG.map(({ id, binary }) => ({ id, binary }));
}

// === Color → Tailwind token mapping ===

export interface CliBrandClasses {
  /** Background tint for the icon swatch (e.g. "bg-accent-amber/15"). */
  iconBg: string;
  /** Foreground color for the icon (e.g. "text-accent-amber"). */
  iconColor: string;
  /** Solid dot color (e.g. "bg-accent-amber"). */
  dotColor: string;
}

const BRAND_CLASS_MAP: Record<CliBrandColor, CliBrandClasses> = {
  amber: {
    iconBg: "bg-accent-amber/15",
    iconColor: "text-accent-amber",
    dotColor: "bg-accent-amber",
  },
  blue: {
    iconBg: "bg-accent-blue/15",
    iconColor: "text-accent-blue",
    dotColor: "bg-accent-blue",
  },
  green: {
    iconBg: "bg-accent-green/15",
    iconColor: "text-accent-green",
    dotColor: "bg-accent-green",
  },
  purple: {
    iconBg: "bg-accent-purple/15",
    iconColor: "text-accent-purple",
    dotColor: "bg-accent-purple",
  },
  red: {
    iconBg: "bg-accent-red/15",
    iconColor: "text-accent-red",
    dotColor: "bg-accent-red",
  },
  neutral: {
    iconBg: "bg-text-secondary/15",
    iconColor: "text-text-secondary",
    dotColor: "bg-text-secondary",
  },
};

/** Resolve Tailwind classes for a brand color slug. */
export function brandClasses(color: CliBrandColor): CliBrandClasses {
  return BRAND_CLASS_MAP[color];
}
