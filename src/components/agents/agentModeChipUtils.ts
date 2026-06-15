import type {
  AgentConversation,
  PermissionMode,
} from "@/types/agent-conversation";
import type { AgentMode } from "./AgentModeChip";

export interface ModeFlags {
  planMode: boolean;
  permissionMode: PermissionMode;
  approveWrites: boolean;
}

const MODE_ORDER: AgentMode[] = ["default", "plan", "manual", "yolo"];

/** Translate the conversation's three flag fields into a single mode label. */
export function deriveMode(conv: AgentConversation): AgentMode {
  if (conv.planMode) return "plan";
  if (conv.permissionMode === "allow_all") return "yolo";
  if (conv.permissionMode === "ask_for_risky" || conv.approveWrites)
    return "manual";
  return "default";
}

/** Reverse map: which flag values represent each mode. */
export function flagsForMode(mode: AgentMode): ModeFlags {
  switch (mode) {
    case "plan":
      return { planMode: true, permissionMode: "auto", approveWrites: false };
    case "manual":
      return {
        planMode: false,
        permissionMode: "ask_for_risky",
        approveWrites: false,
      };
    case "yolo":
      return {
        planMode: false,
        permissionMode: "allow_all",
        approveWrites: false,
      };
    case "default":
    default:
      return { planMode: false, permissionMode: "auto", approveWrites: false };
  }
}

/** Next mode in the cycle (Shift+Tab default direction). */
export function nextMode(mode: AgentMode): AgentMode {
  const idx = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
}
