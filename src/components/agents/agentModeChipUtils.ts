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
 * P1-S4: the postures a provider whose adapter CANNOT honor approval
 * round-trips may present. `manual` (ask_for_risky) and `deny` (deny_all) both
 * imply a per-tool approval such an adapter would silently coerce into a
 * sandbox posture, so they are filtered out — only the three sandbox postures
 * survive, in cycle order. These map onto `SANDBOX_POSTURE_LABEL`.
 *
 * DECISION (kept, not deleted): no live catalog row sets
 * `supportsApprovals: false` since the `codex exec` adapter was removed in
 * 2026-07, so this branch is currently unreachable. It stays because
 * "this adapter cannot pause for approval" is a real, recurring adapter
 * property (see the rationale on `ApiProviderInfo.supportsApprovals`) and
 * because the alternative to a filtered mode set is a picker offering
 * postures the backend silently downgrades — the exact dishonesty this
 * vocabulary exists to prevent. What was DELETED is the copy that named
 * Codex: a future approval-incapable adapter is not Codex, and a tooltip
 * blaming a removed provider is a new lie in place of an old one.
 */
export const SANDBOX_MODE_ORDER: AgentMode[] = ["plan", "default", "yolo"];

/**
 * The mode set a provider may present given whether its adapter can honor
 * approval round-trips. Approval-capable providers get the full `MODE_ORDER`;
 * approval-incapable ones get only the honorable sandbox postures.
 */
export function modesForApprovals(supportsApprovals: boolean): AgentMode[] {
  return supportsApprovals ? MODE_ORDER : SANDBOX_MODE_ORDER;
}

/**
 * Sandbox-vocabulary relabels for the honorable postures. Used ONLY when a
 * provider lacks approval support — approval-capable providers keep the full
 * `MODE_META` labels (Default/Plan/Manual/Deny/Yolo).
 */
export const SANDBOX_POSTURE_LABEL: Record<AgentMode, string> = {
  plan: "Read-only",
  default: "Workspace-write",
  yolo: "Full access",
  manual: "Workspace-write",
  deny: "Read-only",
};

/** Honest one-line description of each sandbox posture. */
export const SANDBOX_POSTURE_DESCRIPTION: Record<AgentMode, string> = {
  plan: "Sandbox blocks all writes — read-only exploration",
  default: "Edits are confined to the workspace sandbox",
  yolo: "No sandbox — full disk & network access",
  manual: "Edits are confined to the workspace sandbox",
  deny: "Sandbox blocks all writes — read-only exploration",
};

/** Tooltip explaining why this provider has no approval-implying postures.
 *  Provider-neutral on purpose — it used to name Codex (exec), which no
 *  catalog row has offered since 2026-07. */
export const SANDBOX_POSTURE_TOOLTIP =
  "This provider can't pause for approvals — the sandbox is the safety boundary";

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
 * capable providers keep the plain labels; approval-incapable ones get the
 * honest sandbox-vocabulary relabels — the same P1-S4 filter the header
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
  // An absent posture is "ask" (see agentTaskStore's default), so the chip
  // must label it Manual, not Default.
  switch (conv.permissionMode ?? "ask_for_risky") {
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
 * When the current mode isn't in the order — e.g. a persisted session still on
 * a now-filtered `manual`/`deny` posture, which is exactly what read-compat
 * with old conversation records produces — the cycle snaps to the first
 * honorable posture rather than getting stuck.
 */
export function nextModeIn(mode: AgentMode, order: AgentMode[]): AgentMode {
  if (order.length === 0) return mode;
  const idx = order.indexOf(mode);
  if (idx === -1) return order[0];
  return order[(idx + 1) % order.length];
}
