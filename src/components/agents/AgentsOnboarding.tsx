import { Folder, Zap, Paperclip, Slash, X, Sparkles } from "lucide-react";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";

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
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-bg-primary/85 backdrop-blur-sm"
      onClick={dismiss}
      role="dialog"
      aria-modal="true"
      aria-label="Agents onboarding"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[640px] mx-6 bg-bg-secondary border border-line-soft rounded-lg shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line-soft">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-accent-soft border border-accent-line grid place-items-center">
              <Sparkles size={14} className="text-accent-green" />
            </div>
            <div className="flex flex-col">
              <span className="text-[13px] font-semibold text-text-primary">
                Welcome to Agents
              </span>
              <span className="text-[10px] text-text-muted">
                A unified chat for every coding agent.
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="p-1 rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 p-5">
          {CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.title}
                className="flex gap-2.5 p-3 rounded-md border border-bg-border bg-bg-primary"
              >
                <div
                  className={`shrink-0 w-7 h-7 rounded-md grid place-items-center ${card.accent}`}
                >
                  <Icon size={14} />
                </div>
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-[11px] font-semibold text-text-primary">
                    {card.title}
                  </span>
                  <span className="text-[10px] leading-snug text-text-secondary">
                    {card.body}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end px-5 py-3 border-t border-line-soft">
          <button
            type="button"
            onClick={dismiss}
            className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
