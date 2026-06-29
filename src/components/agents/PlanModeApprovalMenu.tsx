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
  // Primary, recommended path — filled green per the action recipe.
  green:
    "bg-accent-green/20 hover:bg-accent-green/30 border border-transparent text-accent-green font-medium transition-colors",
  blue:
    "border border-accent-blue/40 text-accent-blue hover:bg-accent-blue/10 transition-colors",
  amber:
    "border border-accent-amber/40 text-accent-amber hover:bg-accent-amber/10 transition-colors",
  muted:
    "border border-bg-border text-text-secondary hover:bg-bg-secondary transition-colors",
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

      <div className="flex flex-col gap-1.5">
        {CHOICES.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => void handle(c.key)}
              className={`flex items-start gap-2 text-[11px] px-2 py-1.5 rounded text-left w-full ${TONE_CLASSES[c.tone]}`}
            >
              <Icon size={12} className="mt-0.5 shrink-0" />
              <span className="flex flex-col min-w-0">
                <span>{c.label}</span>
                <span className="text-[10px] text-text-muted leading-snug">
                  {c.hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
