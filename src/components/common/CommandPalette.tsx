import { useState, useEffect, useRef, useMemo } from "react";
import {
  Search,
  MessageSquare,
  Ticket,
  Clock,
  Wrench,
  Github,
  Brain,
  FileText,
} from "lucide-react";
import { useAppStore, moduleViewId } from "@/stores/appStore";
import { useModuleStore } from "@/stores/moduleStore";
import { getModulesSorted } from "@/modules/registry";
import { usePromptStore } from "@/stores/promptStore";

interface PaletteAction {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  action: () => void;
  keywords?: string[];
}

export function CommandPalette() {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const setActiveView = useAppStore((s) => s.setActiveView);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const moduleStates = useModuleStore((s) => s.states);
  const promptTemplates = usePromptStore((s) => s.templates);
  const sendPromptToAgent = usePromptStore((s) => s.sendToAgentChat);

  const actions = useMemo<PaletteAction[]>(() => {
    const items: PaletteAction[] = [
      {
        id: "workspace",
        label: "Workspace",
        description: "View active workspace panes",
        icon: <MessageSquare size={14} className="text-accent-green" />,
        action: () => setActiveView("workspace"),
        keywords: ["sessions", "claude", "codex", "terminal", "pane"],
      },
      {
        id: "issues",
        label: "Issues Board",
        description: "Kanban issue tracker",
        icon: <Ticket size={14} className="text-accent-amber" />,
        action: () => setActiveView("issues"),
        keywords: ["kanban", "tickets", "board", "todo"],
      },
      {
        id: "history",
        label: "Session History",
        description: "Browse past sessions",
        icon: <Clock size={14} className="text-text-secondary" />,
        action: () => setActiveView("history"),
        keywords: ["past", "log", "previous"],
      },
      {
        id: "github",
        label: "GitHub",
        description: "GitHub integration",
        icon: <Github size={14} className="text-text-primary" />,
        action: () => setActiveView("github"),
        keywords: ["git", "repo", "pr", "pull request"],
      },
      {
        id: "memory",
        label: "Memory",
        description: "AI memory and file map",
        icon: <Brain size={14} className="text-accent-purple" />,
        action: () => setActiveView("memory"),
        keywords: ["context", "knowledge", "files"],
      },
      {
        id: "settings",
        label: "Settings",
        description: "Project and app settings",
        icon: <Wrench size={14} className="text-text-muted" />,
        action: () => setActiveView("tools"),
        keywords: ["config", "preferences", "options"],
      },
    ];

    for (const template of promptTemplates) {
      items.push({
        id: `prompt-${template.id}`,
        label: `Prompt: ${template.name}`,
        description: `Launch ${template.category} prompt in a conversation tile`,
        icon: <FileText size={14} className="text-accent-blue" />,
        action: () => void sendPromptToAgent(template.id),
        keywords: ["prompt", "template", template.category, template.name.toLowerCase()],
      });
    }

    // Add enabled modules
    for (const mod of getModulesSorted()) {
      if (moduleStates[mod.id]?.enabled) {
        const Icon = mod.icon;
        items.push({
          id: `mod-${mod.id}`,
          label: mod.name,
          description: mod.description,
          icon: <Icon size={14} className={mod.iconColor} />,
          action: () => setActiveView(moduleViewId(mod.id)),
          keywords: [mod.id, mod.category],
        });
      }
    }

    return items;
  }, [setActiveView, moduleStates, promptTemplates, sendPromptToAgent]);

  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const q = query.toLowerCase();
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.keywords?.some((k) => k.includes(q)),
    );
  }, [actions, query]);

  // Reset selection when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function close() {
    setCommandPaletteOpen(false);
  }

  function execute(action: PaletteAction) {
    action.action();
    close();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        execute(filtered[selectedIndex]);
      }
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={close}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Palette */}
      <div
        className="relative w-[480px] overflow-hidden rounded-xl border border-bg-border bg-bg-secondary shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-bg-border px-4 py-3">
          <Search size={14} className="flex-shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command..."
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <kbd className="rounded border border-bg-border bg-bg-elevated px-1.5 py-0.5 text-[10px] text-text-muted">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-text-muted">
              No matching commands
            </div>
          ) : (
            filtered.map((action, i) => (
              <button
                key={action.id}
                onClick={() => execute(action)}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  i === selectedIndex
                    ? "bg-accent-green/10 text-text-primary"
                    : "text-text-secondary hover:bg-bg-hover"
                }`}
              >
                {action.icon}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{action.label}</div>
                  {action.description && (
                    <div className="truncate text-[10px] text-text-muted">{action.description}</div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
