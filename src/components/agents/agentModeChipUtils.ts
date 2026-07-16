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
 * P1-S4 (Codex honesty): the postures a provider whose adapter CANNOT honor
 * approval round-trips (Codex `exec`) may present. `manual` (ask_for_risky)
 * and `deny` (deny_all) both imply a per-tool approval the exec adapter
 * silently coerces to a sandbox+`never` tuple, so they are filtered out —
 * only the three sandbox postures survive, in cycle order. These map onto
 * the sandbox vocabulary in `SANDBOX_POSTURE_LABEL`.
 */
export const SANDBOX_MODE_ORDER: AgentMode[] = ["plan", "default", "yolo"];

/**
 * The mode set a provider may present given whether its adapter can honor
 * approval round-trips. Approval-capable providers get the full `MODE_ORDER`;
 * approval-incapable ones (Codex) get only the honorable sandbox postures.
 */
export function modesForApprovals(supportsApprovals: boolean): AgentMode[] {
  return supportsApprovals ? MODE_ORDER : SANDBOX_MODE_ORDER;
}

/**
 * Sandbox-vocabulary relabels for the honorable Codex postures. Used ONLY
 * when a provider lacks approval support — approval-capable providers keep
 * the full `MODE_META` labels (Default/Plan/Manual/Deny/Yolo).
 */
export const SANDBOX_POSTURE_LABEL: Record<AgentMode, string> = {
  plan: "Read-only",
  default: "Workspace-write",
  yolo: "Full access",
  manual: "Workspace-write",
  deny: "Read-only",
};

/** Honest one-line description of each sandbox posture (Codex). */
export const SANDBOX_POSTURE_DESCRIPTION: Record<AgentMode, string> = {
  plan: "Sandbox blocks all writes — read-only exploration",
  default: "Edits are confined to the workspace sandbox",
  yolo: "No sandbox — full disk & network access",
  manual: "Edits are confined to the workspace sandbox",
  deny: "Sandbox blocks all writes — read-only exploration",
};

/** Tooltip explaining why Codex has no approval-implying postures. */
export const SANDBOX_POSTURE_TOOLTIP =
  "Codex (exec) can't pause for approvals — the sandbox is the safety boundary";

/**
 * Plain labels for the full approval-capable mode set (mirrors AgentModeChip's
 * private MODE_META labels — kept here so the draft-tile mode chip can label
 * postures without importing the chip component).
 */
export const MODE_LABEL: Record<AgentMode, string> = {
  default: "Default",
  plan: "Plan",
  manual: "Manual",
  deny: "Deny",
  yolo: "Yolo",
};

/**
 * Label for a posture given whether the provider can honor approvals. Approval-
 * capable providers keep the plain labels; approval-incapable ones (Codex) get
 * the honest sandbox-vocabulary relabels — the same P1-S4 filter the header
 * chip uses, reused so the draft picker and the tile header never disagree.
 */
export function modeLabel(mode: AgentMode, supportsApprovals: boolean): string {
  return supportsApprovals ? MODE_LABEL[mode] : SANDBOX_POSTURE_LABEL[mode];
}

/** Posture description given approval capability (plan labels vs sandbox). */
export function modeDescription(mode: AgentMode, supportsApprovals: boolean): string {
  return supportsApprovals
    ? MODE_LABEL[mode]
    : SANDBOX_POSTURE_DESCRIPTION[mode];
}

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

/**
 * Next mode restricted to a given (possibly capability-filtered) order.
 * When the current mode isn't in the order — e.g. a persisted Codex session
 * still on a now-filtered `manual`/`deny` posture — the cycle snaps to the
 * first honorable posture rather than getting stuck.
 */
export function nextModeIn(mode: AgentMode, order: AgentMode[]): AgentMode {
  if (order.length === 0) return mode;
  const idx = order.indexOf(mode);
  if (idx === -1) return order[0];
  return order[(idx + 1) % order.length];
}
