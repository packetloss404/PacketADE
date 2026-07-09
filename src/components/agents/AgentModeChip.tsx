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
import { providerSupportsApprovals } from "@/lib/api-models";
import { addPaneControlListener, OPEN_MODE_CHIP_EVENT } from "./paneEvents";

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
  deny: {
    label: "Deny",
    icon: Ban,
    color: "text-accent-purple bg-accent-purple/10",
    border: "border-accent-purple/40",
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
  const meta = MODE_META[mode];
  const Icon = meta.icon;

  // P1-S4 (Codex honesty): providers whose adapter can't honor approval
  // round-trips (Codex `exec`) expose ONLY the honorable sandbox postures,
  // relabeled in sandbox vocabulary. Approval-capable providers keep the
  // full five-mode set with its native labels.
  const supportsApprovals = providerSupportsApprovals(conversation.agent);
  const order = modesForApprovals(supportsApprovals);
  const displayLabel = (m: AgentMode): string =>
    supportsApprovals ? MODE_META[m].label : SANDBOX_POSTURE_LABEL[m];
  const displayDescription = (m: AgentMode): string =>
    supportsApprovals ? MODE_META[m].description : SANDBOX_POSTURE_DESCRIPTION[m];

  const next = nextModeIn(mode, order);
  const approveWrites = conversation.approveWrites ?? false;

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
        }
      >
        <button
          type="button"
          onClick={onCycle}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded-l border text-ui transition-colors motion-reduce:transition-none ${meta.color} ${meta.border} hover:brightness-110`}
        >
          <Icon size={11} />
          {displayLabel(mode)}
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
          className={`flex items-center px-0.5 rounded-r border border-l-0 transition-colors motion-reduce:transition-none ${meta.color} ${meta.border} hover:brightness-110`}
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
          className="absolute right-0 top-full z-50 mt-1 w-60 rounded-md border border-bg-border bg-bg-elevated py-1 shadow-xl"
        >
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
