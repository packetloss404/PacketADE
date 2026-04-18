import { Check, Edit3, Eye, MessageSquare } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";

interface PlanModeApprovalMenuProps {
  conversationId: string;
  /** The plan markdown text — currently unused for rendering (the assistant
   *  message above already shows it) but kept on the API in case future
   *  variants want to embed an excerpt or send it back as quoted context. */
  planText?: string;
  onProceed?: () => void;
}

/**
 * Heuristic detector — returns true when the assistant's message looks like
 * a structured plan (Claude-Code-style `## Plan` / `## Files to change` /
 * `## Steps` headers). Case-insensitive, matches at start of any line.
 */
export function looksLikePlan(text: string): boolean {
  if (!text) return false;
  return /(^|\n)\s*##\s+(plan|files to change|steps)\b/i.test(text);
}

type ChoiceKey = "execute" | "accept-edits" | "review-each" | "keep-planning";

interface Choice {
  key: ChoiceKey;
  label: string;
  hint: string;
  icon: typeof Check;
  tone: "green" | "blue" | "amber" | "muted";
}

const CHOICES: Choice[] = [
  {
    key: "execute",
    label: "Approve and execute",
    hint: "Auto-run safe tools",
    icon: Check,
    tone: "green",
  },
  {
    key: "accept-edits",
    label: "Approve and accept edits",
    hint: "Edits without asking; ask on shell",
    icon: Edit3,
    tone: "blue",
  },
  {
    key: "review-each",
    label: "Approve, review each edit",
    hint: "Step-by-step approval",
    icon: Eye,
    tone: "amber",
  },
  {
    key: "keep-planning",
    label: "Keep planning",
    hint: "Refine before committing",
    icon: MessageSquare,
    tone: "muted",
  },
];

const TONE_CLASSES: Record<Choice["tone"], string> = {
  green:
    "border-accent-green/40 text-accent-green hover:bg-accent-green/10",
  blue:
    "border-accent-blue/40 text-accent-blue hover:bg-accent-blue/10",
  amber:
    "border-accent-amber/40 text-accent-amber hover:bg-accent-amber/10",
  muted:
    "border-bg-border text-text-secondary hover:bg-bg-secondary",
};

export function PlanModeApprovalMenu({
  conversationId,
  onProceed,
}: PlanModeApprovalMenuProps) {
  const setPlanMode = useAgentTaskStore((s) => s.setPlanMode);
  const setPermissionMode = useAgentTaskStore((s) => s.setPermissionMode);
  const setApproveWrites = useAgentTaskStore(
    (s) => (s as { setApproveWrites?: (id: string, enabled: boolean) => Promise<void> })
      .setApproveWrites,
  );
  const sendMessage = useAgentTaskStore((s) => s.sendMessage);

  const handle = async (key: ChoiceKey) => {
    switch (key) {
      case "execute": {
        await setPlanMode(conversationId, false);
        await setPermissionMode(conversationId, "auto");
        sendMessage(conversationId, "Plan approved — implement it now.");
        onProceed?.();
        break;
      }
      case "accept-edits": {
        await setPlanMode(conversationId, false);
        await setPermissionMode(conversationId, "auto");
        if (setApproveWrites) {
          await setApproveWrites(conversationId, false);
        }
        sendMessage(
          conversationId,
          "Plan approved — implement it. Make edits without asking; ask before destructive shell commands.",
        );
        onProceed?.();
        break;
      }
      case "review-each": {
        await setPlanMode(conversationId, false);
        await setPermissionMode(conversationId, "ask_for_risky");
        sendMessage(
          conversationId,
          "Plan approved — implement step by step; I'll review each edit.",
        );
        onProceed?.();
        break;
      }
      case "keep-planning": {
        // Keep plan mode ON — just nudge the model to refine.
        sendMessage(
          conversationId,
          "Refine the plan first — explain trade-offs in approach X vs Y, then I'll choose.",
        );
        break;
      }
    }
  };

  return (
    <div className="bg-bg-secondary border border-accent-green/40 rounded p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Check size={14} className="text-accent-green shrink-0" />
        <span className="text-xs text-text-primary">
          Approve and proceed with this plan?
        </span>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {CHOICES.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => void handle(c.key)}
              title={c.hint}
              className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border ${TONE_CLASSES[c.tone]}`}
            >
              <Icon size={12} />
              {c.label}
            </button>
          );
        })}
      </div>

      <p className="text-[10px] text-text-muted leading-snug">
        <span className="text-accent-green">Execute</span> auto-runs safe tools.
        {" "}
        <span className="text-accent-blue">Accept edits</span> applies file
        changes without prompting but still asks before destructive shell
        commands.
        {" "}
        <span className="text-accent-amber">Review each edit</span> pauses on
        every risky tool call so you can approve or deny.
        {" "}
        <span className="text-text-secondary">Keep planning</span> stays in
        plan mode and asks the agent to iterate.
      </p>
    </div>
  );
}
