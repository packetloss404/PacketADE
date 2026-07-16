import { Folder, GitBranch } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import type { ComposerMode } from "./utils";

interface ComposerModePickerProps {
  value: ComposerMode;
  onChange?: (mode: ComposerMode) => void;
}

/** B2: Codex-App-style Local / Worktree picker for "where does the agent
 * run". The choice also persists as the global default for new
 * conversations. */
export function ComposerModePicker({ value, onChange }: ComposerModePickerProps) {
  const opts = [
    {
      mode: "local" as const,
      icon: Folder,
      label: "Local",
      title:
        "Switch to Local — edits land in the project tree (also updates the global default)",
    },
    {
      mode: "worktree" as const,
      icon: GitBranch,
      label: "Worktree",
      title:
        "Switch to Worktree — conversation runs on a fresh branch in .pkt-worktrees/ (also updates the global default)",
    },
  ];

  return (
    <div className="inline-flex rounded border border-bg-border overflow-hidden">
      {opts.map((opt) => {
        const Icon = opt.icon;
        const isActive = value === opt.mode;
        return (
          <Tooltip key={opt.mode} content={opt.title}>
            <button
              type="button"
              onClick={() => onChange?.(opt.mode)}
              className={`flex items-center gap-1 px-1.5 py-0.5 text-ui transition-colors motion-reduce:transition-none ${
                isActive
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
  );
}
