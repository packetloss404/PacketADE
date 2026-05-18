import { useState, lazy, Suspense } from "react";
import {
  Wrench,
  FolderOpen,
  Ticket,
  Puzzle,
  FileText,
  Plus,
  Trash2,
  Route,
  Plug,
  Clock,
  DollarSign,
  Mic,
  Key,
  Server,
  GitBranch,
  Bot,
  Brain,
  Github,
  Settings2,
  Palette,
  ChevronRight,
  Settings,
} from "lucide-react";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import { useGitInfo } from "@/hooks/useGitInfo";
import { useIssueStore } from "@/stores/issueStore";
import { usePromptStore } from "@/stores/promptStore";
import { ProjectInfoCard } from "./tools/ProjectInfoCard";
import { IssueSettingsCard } from "./tools/IssueSettingsCard";
import { TagListCard } from "./tools/TagListCard";
import { ProviderRoutingCard } from "./tools/ProviderRoutingCard";
import { ModulesCard } from "./tools/ModulesCard";
import { NotificationSettingsCard } from "./tools/NotificationSettingsCard";
import { ThemeSettingsCard } from "./tools/ThemeSettingsCard";
import { CrashViewerCard } from "./tools/CrashViewerCard";
import { McpServersCard } from "./tools/McpServersCard";
import { McpProviderCard } from "./tools/McpProviderCard";
import { CostCard } from "./tools/CostCard";
import { DictationSettingsCard } from "./tools/DictationSettingsCard";
import { KeyboardShortcutsCard } from "./tools/KeyboardShortcutsCard";
import { GeminiApiKeyCard } from "./tools/GeminiApiKeyCard";
import { ApiKeysCard } from "./tools/ApiKeysCard";
import { ServersSettingsCard } from "./tools/ServersSettingsCard";
import { AgentProfilesCard } from "./tools/AgentProfilesCard";
import { AgentSettingsCard } from "./tools/AgentSettingsCard";
import { CliAgentsCard } from "./tools/CliAgentsCard";
import { ProjectRulesCard } from "./tools/ProjectRulesCard";
import { OrchestrationSettingsCard } from "./tools/OrchestrationSettingsCard";
import { ProviderEndpointsCard } from "./tools/ProviderEndpointsCard";
import { WorkspaceSettingsCard } from "./tools/WorkspaceSettingsCard";
import { MemorySettingsCard } from "./tools/MemorySettingsCard";
import { GitHubSettingsCard } from "./tools/GitHubSettingsCard";
import { SubscriptionsCard } from "./tools/SubscriptionsCard";
import type { PromptTemplate } from "@/types/prompt";
import { PromptLibrary } from "@/components/workspace/PromptLibrary";

const HistoryView = lazy(() =>
  import("@/components/views/HistoryView").then((m) => ({ default: m.HistoryView })),
);

/**
 * v0.8.1 IA reorganisation.
 *
 * The flat 18-tab Settings sidebar was collapsed into a smaller set of
 * grouped sections that match how users actually think about the app:
 *
 *  - "General" merges Theme + Notifications + Project info
 *  - "Workspace" surfaces workspace-pane-only knobs
 *  - "Agents" stacks CLI Agents, API-mode Agents, and Profiles
 *  - "AI Providers" stacks API Keys + Subscriptions + Provider Endpoints
 *  - "MCP" stacks Servers + Provider in one tab
 *  - "GitHub" mounts the new card from v0.8.1
 *  - "Advanced" is the parking lot for crash logs and jump links to the
 *    full-page views that used to be shoehorned into Settings (History,
 *    Cost Dashboard, Prompt Library).
 */
type SettingsSection =
  | "general"
  | "workspace"
  | "agents"
  | "providers"
  | "routing"
  | "memory"
  | "missions"
  | "github"
  | "issues"
  | "servers"
  | "mcp"
  | "project-rules"
  | "modules"
  | "dictation"
  | "advanced";

const SECTIONS: { key: SettingsSection; label: string; icon: typeof Wrench }[] = [
  { key: "general", label: "General", icon: Palette },
  { key: "workspace", label: "Workspace", icon: FolderOpen },
  { key: "agents", label: "Agents", icon: Bot },
  { key: "providers", label: "AI Providers", icon: Key },
  { key: "routing", label: "AI Routing", icon: Route },
  { key: "memory", label: "Memory", icon: Brain },
  { key: "missions", label: "Missions", icon: GitBranch },
  { key: "github", label: "GitHub", icon: Github },
  { key: "issues", label: "Issues", icon: Ticket },
  { key: "servers", label: "Servers", icon: Server },
  { key: "mcp", label: "MCP", icon: Plug },
  { key: "project-rules", label: "Project Rules", icon: FileText },
  { key: "modules", label: "Modules", icon: Puzzle },
  { key: "dictation", label: "Dictation", icon: Mic },
  { key: "advanced", label: "Advanced", icon: Settings2 },
];

export function ToolsView() {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const gitBranch = useGitInfo();
  const ticketPrefix = useIssueStore((s) => s.ticketPrefix);
  const setTicketPrefix = useIssueStore((s) => s.setTicketPrefix);
  const addEpic = useIssueStore((s) => s.addEpic);
  const addLabel = useIssueStore((s) => s.addLabel);
  const epics = useIssueStore((s) => s.epics);
  const labels = useIssueStore((s) => s.labels);
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const setActiveView = useAppStore((s) => s.setActiveView);

  return (
    <div className="flex h-full bg-bg-primary overflow-hidden">
      {/* Sidebar nav */}
      <div className="w-44 flex-shrink-0 bg-bg-secondary border-r border-bg-border flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-bg-border">
          <Wrench size={14} className="text-accent-amber" />
          <h2 className="text-xs font-semibold text-text-primary">Settings</h2>
        </div>
        <div className="flex flex-col p-2 gap-0.5 overflow-y-auto">
          {SECTIONS.map((section) => (
            <button
              key={section.key}
              onClick={() => setActiveSection(section.key)}
              className={`flex items-center gap-2 px-3 py-2 text-[11px] rounded-lg transition-colors text-left ${
                activeSection === section.key
                  ? "bg-bg-elevated text-accent-green"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
              }`}
            >
              <section.icon size={12} />
              {section.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeSection === "general" && (
          <div className="grid grid-cols-2 gap-4 max-w-2xl">
            <ProjectInfoCard projectPath={projectPath} gitBranch={gitBranch} />
            <ThemeSettingsCard />
            <NotificationSettingsCard />
          </div>
        )}

        {activeSection === "workspace" && (
          <div className="max-w-2xl">
            <WorkspaceSettingsCard />
          </div>
        )}

        {activeSection === "agents" && (
          <div className="max-w-3xl space-y-4">
            <CliAgentsCard />
            <AgentSettingsCard />
            <AgentProfilesCard />
          </div>
        )}

        {activeSection === "providers" && (
          <div className="grid grid-cols-1 gap-4 max-w-3xl">
            <ApiKeysCard />
            <SubscriptionsCard />
            <ProviderEndpointsCard />
          </div>
        )}

        {activeSection === "routing" && (
          <div className="max-w-2xl">
            <ProviderRoutingCard />
          </div>
        )}

        {activeSection === "memory" && (
          <div className="max-w-2xl space-y-3">
            <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1.5">
                <Brain size={12} className="text-accent-green" />
                <h3 className="text-xs font-semibold text-text-primary">Memory pane</h3>
              </div>
              <p className="text-[11px] text-text-muted leading-relaxed">
                Browse, edit, and prune captured patterns and events.
              </p>
              <button
                onClick={() => setActiveView("memory")}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-accent-green border border-accent-green/30 bg-accent-green/10 rounded hover:bg-accent-green/15 transition-colors mt-3"
              >
                <Brain size={12} />
                Manage memory
              </button>
            </div>
            <MemorySettingsCard />
          </div>
        )}

        {activeSection === "missions" && (
          <div className="max-w-2xl">
            <OrchestrationSettingsCard />
          </div>
        )}

        {activeSection === "github" && (
          <div className="max-w-2xl">
            <GitHubSettingsCard />
          </div>
        )}

        {activeSection === "issues" && (
          <div className="grid grid-cols-2 gap-4 max-w-2xl">
            <IssueSettingsCard ticketPrefix={ticketPrefix} setTicketPrefix={setTicketPrefix} />
            <TagListCard
              title="Epics"
              items={epics}
              onAdd={addEpic}
              tagClassName="bg-accent-purple/15 text-accent-purple"
              placeholder="New epic..."
            />
            <TagListCard
              title="Labels"
              items={labels}
              onAdd={addLabel}
              tagClassName="bg-bg-elevated text-text-muted"
              placeholder="New label..."
            />
          </div>
        )}

        {activeSection === "servers" && (
          <div className="max-w-2xl">
            <ServersSettingsCard />
          </div>
        )}

        {activeSection === "mcp" && (
          <div className="grid grid-cols-1 gap-4 max-w-2xl">
            <McpServersCard />
            <McpProviderCard />
          </div>
        )}

        {activeSection === "project-rules" && (
          <div className="max-w-3xl">
            <ProjectRulesCard />
          </div>
        )}

        {activeSection === "modules" && (
          <div className="max-w-2xl">
            <ModulesCard />
          </div>
        )}

        {activeSection === "dictation" && (
          <div className="max-w-2xl space-y-4">
            <DictationSettingsCard />
            <KeyboardShortcutsCard />
            <GeminiApiKeyCard />
          </div>
        )}

        {activeSection === "advanced" && (
          <AdvancedSection
            onOpenHistory={() => setActiveView("history")}
            onOpenCost={() => setActiveView("cost_dashboard")}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Advanced / Diagnostics tab — the "everything else" parking lot. Houses
 * Crash Reports (operational debugging) and jump-links to the full-page
 * views that used to be embedded directly in Settings (History,
 * Cost Dashboard, Prompt Library).
 *
 * Each jump-link gracefully falls back to inline mounting when the target
 * top-level view isn't registered (so existing setActiveView("tools")
 * deep-links keep working in case a view key changes).
 */
function AdvancedSection({
  onOpenHistory,
  onOpenCost,
}: {
  onOpenHistory: () => void;
  onOpenCost: () => void;
}) {
  const [inlineView, setInlineView] = useState<
    null | "history" | "cost" | "prompts"
  >(null);

  return (
    <div className="max-w-3xl space-y-4">
      <CrashViewerCard />

      <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
        <h3 className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-2">
          <Settings2 size={12} className="text-accent-blue" />
          Open in dedicated view
        </h3>
        <p className="text-[10px] text-text-muted mb-3 leading-relaxed">
          These surfaces used to live as their own Settings tabs; they have
          dedicated full-page views in the toolbar. Use the jump links below
          to switch, or expand inline if you only need a quick look.
        </p>
        <div className="space-y-1.5">
          <JumpLink
            label="History"
            icon={Clock}
            description="Past terminal sessions and API agent conversations"
            onJump={onOpenHistory}
            onInline={() => setInlineView((v) => (v === "history" ? null : "history"))}
            inlineOpen={inlineView === "history"}
          />
          <JumpLink
            label="Cost Dashboard"
            icon={DollarSign}
            description="Per-provider spend and analytics (also in the toolbar)"
            onJump={onOpenCost}
            onInline={() => setInlineView((v) => (v === "cost" ? null : "cost"))}
            inlineOpen={inlineView === "cost"}
          />
          <JumpLink
            label="Prompt Templates"
            icon={FileText}
            description="Authoring and editing prompt templates (type / in the agent chat to expand one)"
            onJump={null}
            onInline={() => setInlineView((v) => (v === "prompts" ? null : "prompts"))}
            inlineOpen={inlineView === "prompts"}
          />
        </div>
      </div>

      {inlineView === "history" && (
        <div className="h-[60vh]">
          <Suspense fallback={<div className="text-xs text-text-muted p-4">Loading...</div>}>
            <HistoryView />
          </Suspense>
        </div>
      )}
      {inlineView === "cost" && (
        <div className="grid grid-cols-2 gap-4">
          <CostCard />
        </div>
      )}
      {inlineView === "prompts" && <PromptTemplatesCard />}
    </div>
  );
}

function JumpLink({
  label,
  icon: Icon,
  description,
  onJump,
  onInline,
  inlineOpen,
}: {
  label: string;
  icon: typeof Clock;
  description: string;
  /** When null, the row is inline-only (no dedicated top-level view to jump to). */
  onJump: (() => void) | null;
  onInline: () => void;
  inlineOpen: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 bg-bg-primary border border-bg-border rounded-lg px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <Icon size={12} className="text-text-muted shrink-0" />
        <div className="min-w-0">
          <div className="text-[11px] text-text-primary">{label}</div>
          <div className="text-[10px] text-text-muted truncate">{description}</div>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onInline}
          className="px-2 py-1 text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
        >
          {inlineOpen ? "Hide" : onJump ? "Preview" : "Edit"}
        </button>
        {onJump && (
          <button
            onClick={onJump}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
          >
            Open
            <ChevronRight size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

const CATEGORIES: PromptTemplate["category"][] = [
  "general",
  "debugging",
  "review",
  "feature",
  "custom",
];

function PromptTemplatesCard() {
  const templates = usePromptStore((s) => s.templates);
  const addTemplate = usePromptStore((s) => s.addTemplate);
  const deleteTemplate = usePromptStore((s) => s.deleteTemplate);

  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState<PromptTemplate["category"]>("general");
  // Full-CRUD manager modal. The inline card supports create + delete; the
  // modal adds in-place editing (and is the home of the templates UI now
  // that the Toolbar Prompts button is gone).
  const [showManager, setShowManager] = useState(false);

  function handleAdd() {
    if (!newName.trim() || !newContent.trim()) return;
    addTemplate(newName.trim(), newContent.trim(), newCategory);
    setNewName("");
    setNewContent("");
    setNewCategory("general");
    setShowNew(false);
  }

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          <FileText size={12} className="text-accent-amber" />
          Prompt Templates
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowManager(true)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            title="Open the full template manager (edit, search, send)"
          >
            <Settings size={11} />
            Manage…
          </button>
          <button
            onClick={() => setShowNew(!showNew)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
          >
            <Plus size={11} />
            New
          </button>
        </div>
      </div>

      {showNew && (
        <div className="bg-bg-primary border border-bg-border rounded-lg p-3 mb-4 flex flex-col gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Template name..."
            className="bg-bg-secondary border border-bg-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
          />
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as PromptTemplate["category"])}
            className="bg-bg-secondary border border-bg-border rounded px-2 py-1.5 text-[11px] text-text-secondary focus:outline-none focus:border-accent-green"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="Template prompt content..."
            rows={4}
            className="bg-bg-secondary border border-bg-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green resize-none"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowNew(false)}
              className="px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              className="px-3 py-1 text-[11px] bg-accent-green/15 text-accent-green border border-accent-green/30 rounded hover:bg-accent-green/25 transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {templates.length === 0 ? (
        <p className="text-[10px] text-text-muted text-center py-4">
          No templates yet. Create one to reuse common prompts.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex items-start gap-2 bg-bg-primary border border-bg-border rounded-lg p-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] font-medium text-text-primary">
                    {t.name}
                  </span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber">
                    {t.category}
                  </span>
                </div>
                <p className="text-[10px] text-text-muted line-clamp-2">{t.content}</p>
              </div>
              <button
                onClick={() => deleteTemplate(t.id)}
                className="p-1 text-text-muted hover:text-accent-red transition-colors flex-shrink-0"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {showManager && <PromptLibrary onClose={() => setShowManager(false)} />}
    </div>
  );
}
