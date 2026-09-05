import { useEffect, useRef, useState } from "react";
import { Ban, Bot, Check, ChevronDown, Compass, FileCheck2, Hand, Zap } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import type { AgentConversation } from "@/types/agent-conversation";
import {
  deriveMode,
  modesForApprovals,
  nextModeIn,
  SANDBOX_POSTURE_DESCRIPTION,
  SANDBOX_POSTURE_LABEL,
  SANDBOX_POSTURE_TOOLTIP,
} from "./agentModeChipUtils";
import { capabilitiesFor } from "@/lib/agentCapabilities";
import { addPaneControlListener, OPEN_MODE_CHIP_EVENT } from "./paneEvents";
import { APP_NAME } from "@/lib/brand";

/**
 * Cursor-style five-state agent mode. Derived from the underlying
 * `planMode` / `permissionMode` flags rather than stored separately —
 * `approveWrites` is an orthogonal fine flag that lives in the chip's
 * popover, so it survives any mode change untouched.
 *
 * - **default**: agent has full tools, no per-tool prompts
 * - **plan**: read-only exploration; no edits or commands
 * - **manual**: every risky tool requires explicit approval
 * - **deny**: risky tools are refused automatically (deny_all)
 * - **yolo**: allow-all (skip permission prompts entirely)
 */
export type AgentMode = "default" | "plan" | "manual" | "deny" | "yolo";

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
  // Tones follow escalation, not alphabetical accent order: plan is the safe
  // read-only floor (green), the two "the agent may act" postures are amber,
  // deny is an unusual-but-safe posture (blue), and yolo is the only red.
  default: {
    label: "Default",
    icon: Bot,
    color: "text-accent-amber bg-accent-amber/10",
    border: "border-accent-amber/40",
    description: "Full tools — read, write, run commands",
  },
  plan: {
    label: "Plan",
    icon: Compass,
    color: "text-accent-green bg-accent-green/10",
    border: "border-accent-green/40",
    description: "Read-only exploration; no edits or commands",
  },
  manual: {
    label: "Manual",
    icon: Hand,
    color: "text-accent-amber bg-accent-amber/10",
    border: "border-accent-amber/40",
    description: "Every risky tool requires your approval",
  },
  deny: {
    label: "Deny",
    icon: Ban,
    color: "text-accent-blue bg-accent-blue/10",
    border: "border-accent-blue/40",
    description: "Risky tools are refused without prompting",
  },
  yolo: {
    label: "Yolo",
    icon: Zap,
    color: "text-accent-red bg-accent-red/10",
    border: "border-accent-red/40",
    description: "Allow-all — never prompt for permissions",
  },
};

/**
 * Shown once at the top of the mode popover when a session offers fewer
 * postures than its vocabulary knows about. The restriction is the PROVIDER's
 * ceiling — not an error, and not something the user can lift from here — so
 * the copy names the cause and stops. No "contact your administrator", no
 * retry affordance.
 *
 * (The Q3 design places this beside the sandbox constants in
 * `agentModeChipUtils.ts`. It lives here instead because that module is owned
 * by another workstream; this component is its only consumer, so the export is
 * a drop-in move when the files merge.)
 */
export const RESTRICTED_MODES_HINT =
  `This provider accepts fewer postures than ${APP_NAME} offers — only the ones it will honor are listed.`;

/** Label for the chip when no posture can honestly be named. */
export const PROVIDER_DEFAULT_LABEL = "Provider default";

/**
 * True when `offered` is a proper subset of the vocabulary's full set.
 *
 * The baseline is `modesForApprovals(supportsApprovals)`, NOT `MODE_ORDER` —
 * otherwise every sandbox-vocabulary session (3 of 5 postures by design) would
 * permanently claim to be "restricted", which `SANDBOX_POSTURE_TOOLTIP`
 * already explains in that provider's own words. Two hints on one popover is
 * noise.
 */
function isRestrictedModeSet(
  offered: AgentMode[],
  supportsApprovals: boolean,
): boolean {
  return offered.length < modesForApprovals(supportsApprovals).length;
}

interface AgentModeChipProps {
  conversation: AgentConversation;
  onCycle: () => void;
  onSelectMode: (mode: AgentMode) => void;
  onSetApproveWrites: (enabled: boolean) => void;
}

/**
 * Compact pill that shows the current agent mode and cycles to the next
 * mode on click. Pair with a Shift+Tab keybind in the textarea handler so
 * the cycle is reachable without a mouse mid-typing — that pattern is the
 * #1 ergonomic decision callout in the Claude Code research roundup.
 *
 * The chevron segment opens the fine-flags popover: pick any mode directly
 * (including Deny, which the cycle also visits) and toggle Approve writes.
 * This chip is the single header control for autonomy — the old standalone
 * Plan toggle, permission <select>, and Approve-writes toggle collapsed
 * into it.
 */
export function AgentModeChip({
  conversation,
  onCycle,
  onSelectMode,
  onSetApproveWrites,
}: AgentModeChipProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = deriveMode(conversation);

  // P1-S4: providers whose adapter can't honor approval round-trips expose
  // ONLY the honorable sandbox postures, relabeled in sandbox vocabulary.
  // Approval-capable providers keep the full five-mode set with its native
  // labels. No live catalog row is approval-incapable today — see the DECISION
  // note on `SANDBOX_MODE_ORDER` for why the branch is kept anyway.
  //
  // Both facts now come from the ONE capability descriptor rather than from a
  // provider-identity lookup here (see lib/agentCapabilities.ts).
  const caps = capabilitiesFor(conversation);
  const supportsApprovals = caps.permissionVocabulary === "approval";
  const order = caps.permissionModes;
  const displayLabel = (m: AgentMode): string =>
    supportsApprovals ? MODE_META[m].label : SANDBOX_POSTURE_LABEL[m];
  const displayDescription = (m: AgentMode): string =>
    supportsApprovals ? MODE_META[m].description : SANDBOX_POSTURE_DESCRIPTION[m];

  const next = nextModeIn(mode, order);
  const approveWrites = conversation.approveWrites ?? false;

  // ── What the chip is allowed to CLAIM ────────────────────────────────────
  //
  // Hide-don't-disable: `order` is already the truthful intersection, so an
  // unsupported posture simply has no row. What is left is the collapsed
  // label, and it has three cases:
  //
  //  (a) the derived posture IS offered — label it, exactly as before.
  //  (b) it is NOT — PacketBench's override was dropped by the backend and the
  //      session is running on the PROVIDER's own default — "Provider
  //      default", neutral tone, no icon that implies an escalation level.
  //      The UI must not guess a mode here: "Default" is a PacketBench posture
  //      with a specific meaning (full tools, no prompts), so falling back to
  //      it would be exactly that guess.
  //
  // A restricted set is a CONFIGURATION, never a warning: no red, no
  // AlertTriangle, no Lock. Neutral is the absence of a claim.
  const restricted = isRestrictedModeSet(order, supportsApprovals);
  // An EMPTY order is "this surface has no posture vocabulary at all" (a PTY
  // conversation), not "the provider refused yours" — keep labelling the
  // derived posture there rather than claiming a provider default nobody
  // advertised. Composer only mounts the chip on a non-empty set anyway.
  const postureOffered = order.length === 0 || order.includes(mode);
  const meta = postureOffered
    ? MODE_META[mode]
    : {
        label: PROVIDER_DEFAULT_LABEL,
        icon: Bot,
        color: "text-text-secondary bg-bg-tertiary",
        border: "border-bg-border",
      };
  const Icon = meta.icon;
  const chipLabel = postureOffered ? displayLabel(mode) : meta.label;

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // `/permissions` slash command → open this chip's fine-flags popover.
  useEffect(
    () =>
      addPaneControlListener(OPEN_MODE_CHIP_EVENT, conversation.id, () =>
        setOpen(true),
      ),
    [conversation.id],
  );

  return (
    <div ref={rootRef} className="relative flex items-stretch">
      <Tooltip
        content={
          postureOffered ? (
            <span>
              {displayLabel(mode)}: {displayDescription(mode)}
              {!supportsApprovals && (
                <>
                  <br />
                  {SANDBOX_POSTURE_TOOLTIP}
                </>
              )}
              {approveWrites && (
                <>
                  <br />
                  Approve writes: on
                </>
              )}
              <br />
              Shift+Tab → {displayLabel(next)}
            </span>
          ) : (
            <span>
              {PROVIDER_DEFAULT_LABEL}
              <br />
              {APP_NAME} did not set a posture — the provider chose this one.
              {approveWrites && (
                <>
                  <br />
                  Approve writes: on
                </>
              )}
              <br />
              Shift+Tab → {displayLabel(next)}
            </span>
          )
        }
      >
        <button
          type="button"
          onClick={onCycle}
          className={`flex items-center gap-1 rounded-l-md border py-0.5 pl-2 pr-1.5 text-chip transition-colors motion-reduce:transition-none ${meta.color} ${meta.border} hover:brightness-110`}
        >
          <Icon size={11} />
          {chipLabel}
          {approveWrites && (
            <span
              className="h-1 w-1 rounded-full bg-accent-amber"
              aria-hidden="true"
            />
          )}
        </button>
      </Tooltip>
      <Tooltip content="Permission options">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Permission options"
          className={`flex items-center rounded-r-md border border-l-0 px-1 transition-colors motion-reduce:transition-none ${meta.color} ${meta.border} hover:brightness-110`}
        >
          <ChevronDown
            size={11}
            className={`transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </Tooltip>
      {open && (
        <div
          role="menu"
          // The chip lives on the composer, which sits on the bottom edge of
          // the pane — the popover must open UPWARD or it renders off-screen.
          className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-60 rounded-lg border border-bg-border bg-bg-elevated py-1 shadow-xl"
        >
          {/* The explanation appears only where the user has already asked the
              question — inside the popover they opened in order to change
              posture. Never a banner, never a toast. */}
          {restricted && (
            <div className="border-b border-bg-border px-3 pb-1.5 pt-1 text-meta text-text-faint">
              {RESTRICTED_MODES_HINT}
            </div>
          )}
          {order.map((m) => {
            const rowMeta = MODE_META[m];
            const RowIcon = rowMeta.icon;
            const selected = m === mode;
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onSelectMode(m);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-bg-hover"
              >
                <RowIcon
                  size={12}
                  className={`mt-0.5 shrink-0 ${selected ? "text-text-primary" : "text-text-muted"}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-ui text-text-primary">
                    {displayLabel(m)}
                  </span>
                  <span className="block text-meta text-text-muted">
                    {displayDescription(m)}
                  </span>
                </span>
                {selected && (
                  <Check size={11} className="mt-0.5 shrink-0 text-accent-green" />
                )}
              </button>
            );
          })}
          <div className="my-1 border-t border-bg-border" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={approveWrites}
            onClick={() => onSetApproveWrites(!approveWrites)}
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-bg-hover"
          >
            <FileCheck2
              size={12}
              className={`mt-0.5 shrink-0 ${approveWrites ? "text-accent-amber" : "text-text-muted"}`}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-ui text-text-primary">
                Approve writes
              </span>
              <span className="block text-meta text-text-muted">
                Confirm each file write before it lands
              </span>
            </span>
            <span
              className={`mt-0.5 shrink-0 text-meta ${approveWrites ? "text-accent-amber" : "text-text-muted"}`}
            >
              {approveWrites ? "On" : "Off"}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
