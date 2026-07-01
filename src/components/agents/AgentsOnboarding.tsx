import { Folder, Zap, Paperclip, Slash, Sparkles } from "lucide-react";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { Modal } from "@/components/ui/Modal";

interface OnboardingCard {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  body: string;
  accent: string;
}

const CARDS: OnboardingCard[] = [
  {
    icon: Folder,
    title: "Pick a project",
    body: "Choose a local folder or an SSH target. The agent's tools (read/write/run) all run inside this scope.",
    accent: "text-accent-blue bg-accent-blue/10",
  },
  {
    icon: Zap,
    title: "Pick a provider",
    body: "Anthropic, OpenAI, MiniMax, OpenRouter, or local Ollama — same chat UI for every backend. Auth status auto-refreshes.",
    accent: "text-accent-amber bg-accent-amber/10",
  },
  {
    icon: Paperclip,
    title: "Drop in context",
    body: "Mention files with @, drag-drop attachments into the input, or paste a screenshot. The agent sees what you see.",
    accent: "text-accent-purple bg-accent-purple/10",
  },
  {
    icon: Slash,
    title: "Try slash commands",
    body: "Type / for plan, model, permissions, compact, usage, history, your saved templates, and project skills.",
    accent: "text-accent-green bg-accent-green/10",
  },
];

/**
 * One-time welcome overlay shown the first time a user opens the Agents view.
 * Dismissed via the Agents settings store and can be shown again from Settings.
 */
export function AgentsOnboarding() {
  const onboardingDismissed = useAgentSettingsStore(
    (s) => s.onboardingDismissed,
  );
  const dismiss = useAgentSettingsStore((s) => s.dismissOnboarding);

  if (onboardingDismissed) return null;

  return (
    <Modal
      title="Welcome to Agents"
      width="w-[640px]"
      closeOnEscape
      onClose={dismiss}
      icon={
        <div className="w-7 h-7 rounded bg-accent-soft border border-accent-line grid place-items-center">
          <Sparkles size={14} className="text-accent-green" />
        </div>
      }
      footer={
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={dismiss}
            autoFocus
            className="px-3 py-1.5 rounded border border-accent-green/30 text-[11px] font-medium bg-accent-green/15 text-accent-green hover:bg-accent-green/25 transition-colors"
          >
            Got it
          </button>
        </div>
      }
    >
      <div className="p-5">
        <p className="text-[11px] text-text-muted mb-3">
          A unified chat for every coding agent.
        </p>
        <div className="grid grid-cols-2 gap-3">
          {CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.title}
                className="flex gap-2.5 p-3 rounded border border-bg-border bg-bg-primary"
              >
                <div
                  className={`shrink-0 w-7 h-7 rounded grid place-items-center ${card.accent}`}
                >
                  <Icon size={14} />
                </div>
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-xs font-semibold text-text-primary">
                    {card.title}
                  </span>
                  <span className="text-[11px] leading-relaxed text-text-secondary">
                    {card.body}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
