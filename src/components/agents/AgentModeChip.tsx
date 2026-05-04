import { Bot, Compass, Hand, Zap } from "lucide-react";
import type { AgentConversation } from "@/types/agent-conversation";
import { deriveMode, nextMode } from "./agentModeChipUtils";

/**
 * Cursor-style four-state agent mode. Derived from the underlying
 * `planMode` / `permissionMode` / `approveWrites` flags rather than stored
 * separately — that way users who tweak the fine-grained toggles below the
 * chip still see a sensible label, and the chip is just a quick-set
 * affordance.
 *
 * - **default**: agent has full tools, no per-tool prompts
 * - **plan**: read-only exploration; no edits or commands
 * - **manual**: every risky tool requires explicit approval
 * - **yolo**: allow-all (skip permission prompts entirely)
 */
export type AgentMode = "default" | "plan" | "manual" | "yolo";

const MODE_META: Record<
  AgentMode,
  {
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    color: string;
    border: string;
    description: string;
  }
> = {
  default: {
    label: "Default",
    icon: Bot,
    color: "text-accent-green bg-accent-green/10",
    border: "border-accent-green/40",
    description: "Full tools — read, write, run commands",
  },
  plan: {
    label: "Plan",
    icon: Compass,
    color: "text-accent-amber bg-accent-amber/10",
    border: "border-accent-amber/40",
    description: "Read-only exploration; no edits or commands",
  },
  manual: {
    label: "Manual",
    icon: Hand,
    color: "text-accent-blue bg-accent-blue/10",
    border: "border-accent-blue/40",
    description: "Every risky tool requires your approval",
  },
  yolo: {
    label: "Yolo",
    icon: Zap,
    color: "text-accent-red bg-accent-red/10",
    border: "border-accent-red/40",
    description: "Allow-all — never prompt for permissions",
  },
};

interface AgentModeChipProps {
  conversation: AgentConversation;
  onCycle: () => void;
}

/**
 * Compact pill that shows the current agent mode and cycles to the next
 * mode on click. Pair with a Shift+Tab keybind in the textarea handler so
 * the cycle is reachable without a mouse mid-typing — that pattern is the
 * #1 ergonomic decision callout in the Claude Code research roundup.
 */
export function AgentModeChip({ conversation, onCycle }: AgentModeChipProps) {
  const mode = deriveMode(conversation);
  const meta = MODE_META[mode];
  const Icon = meta.icon;
  const next = nextMode(mode);
  const nextMeta = MODE_META[next];

  return (
    <button
      type="button"
      onClick={onCycle}
      title={`${meta.label}: ${meta.description}\nShift+Tab → ${nextMeta.label}`}
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${meta.color} ${meta.border} hover:brightness-110`}
    >
      <Icon size={11} />
      {meta.label}
    </button>
  );
}
