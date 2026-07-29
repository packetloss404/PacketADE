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
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
  PackageCheck,
  RefreshCw,
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
import { McpHubCard } from "./tools/McpHubCard";
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
import { TrustProvenanceCard } from "./tools/TrustProvenanceCard";
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
  | "flights"
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
  { key: "flights", label: "Flights", icon: GitBranch },
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
    <div className="flex h-full overflow-hidden bg-bg-primary">
      {/* Sidebar nav */}
      <div className="flex w-44 flex-shrink-0 flex-col border-r border-bg-border bg-bg-secondary">
        <div className="flex items-center gap-2 border-b border-bg-border px-4 py-3">
          <Wrench size={14} className="text-accent-amber" />
          <h2 className="text-xs font-semibold text-text-primary">Settings</h2>
        </div>
        <div className="flex flex-col gap-0.5 overflow-y-auto p-2">
          {SECTIONS.map((section) => (
            <button
              key={section.key}
              onClick={() => setActiveSection(section.key)}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] transition-colors ${
                activeSection === section.key
                  ? "bg-bg-elevated text-accent-green"
                  : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
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
          <div className="grid max-w-2xl grid-cols-2 gap-4">
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
          <div className="grid max-w-3xl grid-cols-1 gap-4">
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
            <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
              <div className="mb-1.5 flex items-center gap-2">
                <Brain size={12} className="text-accent-green" />
                <h3 className="text-xs font-semibold text-text-primary">Memory pane</h3>
              </div>
              <p className="text-[11px] leading-relaxed text-text-muted">
                Browse, edit, and prune captured patterns and events.
              </p>
              <button
                onClick={() => setActiveView("memory")}
                className="border-accent-green/30 bg-accent-green/10 hover:bg-accent-green/15 mt-3 inline-flex items-center gap-1.5 rounded border px-3 py-2 text-xs text-accent-green transition-colors"
              >
                <Brain size={12} />
                Manage memory
              </button>
            </div>
            <MemorySettingsCard />
          </div>
        )}

        {activeSection === "flights" && (
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
          <div className="grid max-w-2xl grid-cols-2 gap-4">
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
          <div className="max-w-3xl">
            <McpHubCard />
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
  const [inlineView, setInlineView] = useState<null | "history" | "cost" | "prompts">(null);

  return (
    <div className="max-w-3xl space-y-4">
      <ReleaseTrustCard />
      <TrustProvenanceCard />
      <CrashViewerCard />

      <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
        <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-text-primary">
          <Settings2 size={12} className="text-accent-blue" />
          Open in dedicated view
        </h3>
        <p className="mb-3 text-[10px] leading-relaxed text-text-muted">
          These surfaces used to live as their own Settings tabs; they have dedicated full-page
          views in the toolbar. Use the jump links below to switch, or expand inline if you only
          need a quick look.
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
          <Suspense fallback={<div className="p-4 text-xs text-text-muted">Loading...</div>}>
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

function ReleaseTrustCard() {
  const releaseItems = [
    {
      label: "Install channel",
      status: "Manual GitHub Releases",
      tone: "text-accent-amber",
      icon: PackageCheck,
    },
    {
      label: "Code signing",
      status: "Not configured for beta builds",
      tone: "text-text-muted",
      icon: ShieldCheck,
    },
    {
      label: "Auto-updater",
      status: "Runbook drafted, not enabled",
      tone: "text-text-muted",
      icon: RefreshCw,
    },
    {
      label: "Local release gates",
      status: "lint, build, cargo check, tauri build",
      tone: "text-accent-green",
      icon: AlertTriangle,
    },
  ];

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <ShieldCheck size={12} className="text-accent-green" />
          Release Trust
        </h3>
        <a
          href="https://github.com/packetloss404/PacketADE/releases"
          target="_blank"
          rel="noreferrer"
          className="hover:bg-accent-green/10 flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] text-accent-green transition-colors"
        >
          Releases
          <ExternalLink size={10} />
        </a>
      </div>
      <p className="mb-3 text-[10px] leading-relaxed text-text-muted">
        Beta builds are installed manually. Signing certificates and the Tauri updater are planned
        release-trust gates, not active guarantees in the current repo.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {releaseItems.map(({ label, status, tone, icon: Icon }) => (
          <div
            key={label}
            className="min-w-0 rounded-lg border border-bg-border bg-bg-primary px-3 py-2"
          >
            <div className="mb-1 flex items-center gap-1.5 text-[10px] text-text-muted">
              <Icon size={10} className={tone} />
              {label}
            </div>
            <div className={`text-[10px] leading-snug ${tone}`}>{status}</div>
          </div>
        ))}
      </div>
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
    <div className="flex items-center justify-between gap-2 rounded-lg border border-bg-border bg-bg-primary px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={12} className="shrink-0 text-text-muted" />
        <div className="min-w-0">
          <div className="text-[11px] text-text-primary">{label}</div>
          <div className="truncate text-[10px] text-text-muted">{description}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={onInline}
          className="rounded px-2 py-1 text-[10px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          {inlineOpen ? "Hide" : onJump ? "Preview" : "Edit"}
        </button>
        {onJump && (
          <button
            onClick={onJump}
            className="hover:bg-accent-green/10 flex items-center gap-1 rounded px-2 py-1 text-[10px] text-accent-green transition-colors"
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
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <FileText size={12} className="text-accent-amber" />
          Prompt Templates
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowManager(true)}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            title="Open the full template manager (edit, search, send)"
          >
            <Settings size={11} />
            Manage…
          </button>
          <button
            onClick={() => setShowNew(!showNew)}
            className="hover:bg-accent-green/10 flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent-green transition-colors"
          >
            <Plus size={11} />
            New
          </button>
        </div>
      </div>

      {showNew && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg border border-bg-border bg-bg-primary p-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Template name..."
            className="rounded border border-bg-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
          />
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as PromptTemplate["category"])}
            className="rounded border border-bg-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-secondary focus:border-accent-green focus:outline-none"
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
            className="resize-none rounded border border-bg-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
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
              className="bg-accent-green/15 border-accent-green/30 hover:bg-accent-green/25 rounded border px-3 py-1 text-[11px] text-accent-green transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {templates.length === 0 ? (
        <p className="py-4 text-center text-[10px] text-text-muted">
          No templates yet. Create one to reuse common prompts.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex items-start gap-2 rounded-lg border border-bg-border bg-bg-primary p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[11px] font-medium text-text-primary">{t.name}</span>
                  <span className="bg-accent-amber/15 rounded px-1.5 py-0.5 text-[9px] text-accent-amber">
                    {t.category}
                  </span>
                </div>
                <p className="line-clamp-2 text-[10px] text-text-muted">{t.content}</p>
              </div>
              <button
                onClick={() => deleteTemplate(t.id)}
                className="flex-shrink-0 p-1 text-text-muted transition-colors hover:text-accent-red"
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
