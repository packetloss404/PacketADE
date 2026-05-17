import { Sparkles, Terminal, Plane, KanbanSquare, Github, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppStore, type AppView } from "@/stores/appStore";

type RailItem = {
  id: AppView;
  icon: LucideIcon;
  label: string;
  matches?: AppView[];
};

const ITEMS: RailItem[] = [
  { id: "agents", icon: Sparkles, label: "Agents" },
  { id: "workspace", icon: Terminal, label: "Workspace" },
  { id: "missions", icon: Plane, label: "Flight Deck" },
  { id: "issues", icon: KanbanSquare, label: "Issues" },
  { id: "github", icon: Github, label: "GitHub" },
];

export function LeftRail() {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);

  return (
    <div className="flex flex-col items-center w-11 bg-bg-secondary border-r border-bg-border py-2 gap-0.5 flex-shrink-0">
      {ITEMS.map((it) => {
        const isActive = it.matches
          ? it.matches.includes(activeView)
          : activeView === it.id;
        const Icon = it.icon;
        return (
          <button
            key={it.id}
            onClick={() => setActiveView(it.id)}
            title={it.label}
            className={`relative w-8 h-8 grid place-items-center rounded-md transition-colors ${
              isActive
                ? "bg-bg-elevated text-text-primary"
                : "text-text-muted hover:text-text-primary hover:bg-bg-tertiary"
            }`}
          >
            {isActive && (
              <span
                className="absolute -left-2 top-1.5 bottom-1.5 w-0.5 rounded-sm"
                style={{ background: "var(--color-accent-green)" }}
              />
            )}
            <Icon size={15} />
          </button>
        );
      })}

      <div className="flex-1" />

      <button
        onClick={() => setActiveView("tools")}
        title="Settings"
        className={`w-8 h-8 grid place-items-center rounded-md transition-colors ${
          activeView === "tools"
            ? "bg-bg-elevated text-text-primary"
            : "text-text-muted hover:text-text-primary hover:bg-bg-tertiary"
        }`}
      >
        <Settings size={15} />
      </button>
    </div>
  );
}
