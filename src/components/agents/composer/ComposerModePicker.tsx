import { Folder, GitBranch, Cloud } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import type { ComposerMode } from "./utils";

interface ComposerModePickerProps {
  value: ComposerMode;
  onChange?: (mode: ComposerMode) => void;
}

/** B2: Codex-App-style Local / Worktree / Cloud picker. Cloud is greyed-out
 * — no cloud delegation surface yet, but the slot teaches the mental model
 * and reserves the affordance. */
export function ComposerModePicker({ value, onChange }: ComposerModePickerProps) {
  const opts = [
    {
      mode: "local" as const,
      icon: Folder,
      label: "Local",
      title:
        "Switch to Local — edits land in the project tree (also updates the global default)",
      disabled: false,
    },
    {
      mode: "worktree" as const,
      icon: GitBranch,
      label: "Worktree",
      title:
        "Switch to Worktree — conversation runs on a fresh branch in .pkt-worktrees/ (also updates the global default)",
      disabled: false,
    },
    {
      mode: "cloud" as const,
      icon: Cloud,
      label: "Cloud",
      title:
        "Switch to Cloud — coming soon, cloud delegation not yet wired (also updates the global default)",
      disabled: true,
    },
  ];

  return (
    <div className="inline-flex flex-col">
      <div className="inline-flex rounded border border-bg-border overflow-hidden">
        {opts.map((opt) => {
          const Icon = opt.icon;
          const isActive = value === opt.mode;
          const isDisabled = opt.disabled;
          return (
            <Tooltip key={opt.mode} content={opt.title}>
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => !isDisabled && onChange?.(opt.mode)}
                className={`flex items-center gap-1 px-1.5 py-0.5 text-ui transition-colors motion-reduce:transition-none ${
                  isDisabled
                    ? "text-text-faint opacity-50 cursor-not-allowed"
                    : isActive
                      ? "bg-accent-purple/10 text-accent-purple"
                      : "text-text-muted hover:text-text-primary hover:bg-bg-hover"
                }`}
              >
                <Icon size={10} />
                {opt.label}
              </button>
            </Tooltip>
          );
        })}
      </div>
      <span className="text-meta text-text-muted mt-0.5 leading-tight">
        Persists as default for new conversations.
      </span>
    </div>
  );
}
