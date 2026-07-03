import { Check, Edit3, Eye, MessageSquare } from "lucide-react";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
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
  const sendMessage = useAgentTaskStore((s) => s.sendMessage);
  // Unified approval path: approvePlan flips planApproved (so PlanPanel's
  // proposed/approved state stays in sync), lifts plan mode, applies the
  // chosen permission posture AFTER the lift (sidecar sessions share one
  // wire dimension between plan and permission mode, so setting the posture
  // first would get clobbered back to "default"), and dispatches the
  // execute turn exactly once — repeat clicks no-op instead of
  // double-sending.
  const approvePlan = useAgentPlanStore((s) => s.approvePlan);

  const handle = (key: ChoiceKey) => {
    switch (key) {
      case "execute": {
        approvePlan(conversationId, "Plan approved — implement it now.", {
          permissionMode: "auto",
        });
        onProceed?.();
        break;
      }
      case "accept-edits": {
        approvePlan(
          conversationId,
          "Plan approved — implement it. Make edits without asking; ask before destructive shell commands.",
          { permissionMode: "auto", approveWrites: false },
        );
        onProceed?.();
        break;
      }
      case "review-each": {
        approvePlan(
          conversationId,
          "Plan approved — implement step by step; I'll review each edit.",
          { permissionMode: "ask_for_risky" },
        );
        onProceed?.();
        break;
      }
      case "keep-planning": {
        // Keep plan mode ON — just nudge the model to refine.
        sendMessage(
          conversationId,
          "Don't implement yet — refine the plan: call out risks, open questions, and any alternatives worth weighing, then wait for my approval.",
        );
        break;
      }
    }
  };

  return (
    <div className="bg-bg-secondary border border-accent-green/40 rounded p-3 flex flex-col gap-2 animate-[welcomeFadeIn_150ms_ease-out] motion-reduce:animate-none">
      <div className="flex items-center gap-2">
        <Check size={14} className="text-accent-green shrink-0" />
        <span className="text-ui text-text-primary">
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
              onClick={() => handle(c.key)}
              className={`flex items-start gap-2 text-ui px-2 py-1.5 rounded text-left w-full ${TONE_CLASSES[c.tone]}`}
            >
              <Icon size={12} className="mt-0.5 shrink-0" />
              <span className="flex flex-col min-w-0">
                <span>{c.label}</span>
                <span className="text-meta text-text-muted leading-snug">
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
