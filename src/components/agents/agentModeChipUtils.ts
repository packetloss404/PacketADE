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

export const MODE_ORDER: AgentMode[] = [
  "default",
  "plan",
  "manual",
  "deny",
  "yolo",
];

/**
 * Translate the conversation's flag fields into a single mode label.
 *
 * The mode is a bijection over (planMode, permissionMode) ONLY — every
 * permission posture (including deny_all) has its own label, and
 * `approveWrites` is an orthogonal fine flag surfaced in the chip's popover
 * rather than folded into the label. That separation is what lets
 * `flagsForMode` round-trip approveWrites untouched.
 */
export function deriveMode(conv: AgentConversation): AgentMode {
  if (conv.planMode) return "plan";
  switch (conv.permissionMode ?? "auto") {
    case "allow_all":
      return "yolo";
    case "deny_all":
      return "deny";
    case "ask_for_risky":
      return "manual";
    default:
      return "default";
  }
}

/**
 * Reverse map: which flag values represent each mode. The caller passes the
 * conversation's current `approveWrites`, which is carried through unchanged
 * in every branch — cycling or picking a mode must never clobber it.
 */
export function flagsForMode(mode: AgentMode, approveWrites = false): ModeFlags {
  switch (mode) {
    case "plan":
      return { planMode: true, permissionMode: "auto", approveWrites };
    case "manual":
      return {
        planMode: false,
        permissionMode: "ask_for_risky",
        approveWrites,
      };
    case "deny":
      return { planMode: false, permissionMode: "deny_all", approveWrites };
    case "yolo":
      return { planMode: false, permissionMode: "allow_all", approveWrites };
    case "default":
    default:
      return { planMode: false, permissionMode: "auto", approveWrites };
  }
}

/** Next mode in the cycle (Shift+Tab default direction). */
export function nextMode(mode: AgentMode): AgentMode {
  const idx = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
}
