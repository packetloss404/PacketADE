import { useState, lazy, Suspense } from "react";
import { Wrench, FolderOpen, Ticket, Puzzle, FileText, Plus, Trash2, Route, Plug, Clock, DollarSign, RadioTower, Mic, Key, Server, User } from "lucide-react";
import { useLayoutStore } from "@/stores/layoutStore";
import { useGitInfo } from "@/hooks/useGitInfo";
import { useIssueStore } from "@/stores/issueStore";
import { usePromptStore } from "@/stores/promptStore";
import { ProjectInfoCard } from "./tools/ProjectInfoCard";
import { IssueSettingsCard } from "./tools/IssueSettingsCard";
import { TagListCard } from "./tools/TagListCard";
import { ProviderRoutingCard } from "./tools/ProviderRoutingCard";
import { ModulesCard } from "./tools/ModulesCard";
import { NotificationSettingsCard } from "./tools/NotificationSettingsCard";
import { CrashViewerCard } from "./tools/CrashViewerCard";
import { McpServersCard } from "./tools/McpServersCard";
import { McpProviderCard } from "./tools/McpProviderCard";
import { CostCard } from "./tools/CostCard";
import { DictationCard } from "./tools/DictationCard";
import { ApiKeysCard } from "./tools/ApiKeysCard";
import { ServersSettingsCard } from "./tools/ServersSettingsCard";
import { AgentProfilesCard } from "./tools/AgentProfilesCard";
import type { PromptTemplate } from "@/types/prompt";

const HistoryView = lazy(() => import("@/components/views/HistoryView").then((m) => ({ default: m.HistoryView })));

type SettingsSection = "project" | "issues" | "routing" | "api-keys" | "servers" | "mcp" | "mcp-provider" | "profiles" | "modules" | "templates" | "history" | "cost" | "dictation";

const SECTIONS: { key: SettingsSection; label: string; icon: typeof Wrench }[] = [
  { key: "project", label: "Project", icon: FolderOpen },
  { key: "issues", label: "Issues", icon: Ticket },
  { key: "routing", label: "AI Routing", icon: Route },
  { key: "api-keys", label: "API Keys", icon: Key },
  { key: "servers", label: "Servers", icon: Server },
  { key: "mcp", label: "MCP Servers", icon: Plug },
  { key: "mcp-provider", label: "MCP Provider", icon: RadioTower },
  { key: "profiles", label: "Agent Profiles", icon: User },
  { key: "modules", label: "Modules", icon: Puzzle },
  { key: "templates", label: "Templates", icon: FileText },
  { key: "history", label: "History", icon: Clock },
  { key: "cost", label: "Cost", icon: DollarSign },
  { key: "dictation", label: "Dictation", icon: Mic },
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
  const [activeSection, setActiveSection] = useState<SettingsSection>("project");

  return (
    <div className="flex h-full bg-bg-primary overflow-hidden">
      {/* Sidebar nav */}
      <div className="w-44 flex-shrink-0 bg-bg-secondary border-r border-bg-border flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-bg-border">
          <Wrench size={14} className="text-accent-amber" />
          <h2 className="text-xs font-semibold text-text-primary">Settings</h2>
        </div>
        <div className="flex flex-col p-2 gap-0.5">
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
        {activeSection === "project" && (
          <div className="grid grid-cols-2 gap-4 max-w-2xl">
            <ProjectInfoCard projectPath={projectPath} gitBranch={gitBranch} />
            <NotificationSettingsCard />
            <CrashViewerCard />
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

        {activeSection === "routing" && (
          <div className="max-w-2xl">
            <ProviderRoutingCard />
          </div>
        )}

        {activeSection === "api-keys" && (
          <div className="max-w-2xl">
            <ApiKeysCard />
          </div>
        )}

        {activeSection === "servers" && (
          <div className="max-w-2xl">
            <ServersSettingsCard />
          </div>
        )}

        {activeSection === "mcp" && (
          <div className="max-w-2xl">
            <McpServersCard />
          </div>
        )}

        {activeSection === "mcp-provider" && (
          <div className="max-w-2xl">
            <McpProviderCard />
          </div>
        )}

        {activeSection === "profiles" && (
          <div className="max-w-3xl">
            <AgentProfilesCard />
          </div>
        )}

        {activeSection === "modules" && (
          <div className="max-w-2xl">
            <ModulesCard />
          </div>
        )}

        {activeSection === "templates" && (
          <div className="max-w-2xl">
            <PromptTemplatesCard />
          </div>
        )}

        {activeSection === "history" && (
          <div className="max-w-4xl h-full">
            <Suspense fallback={<div className="text-xs text-text-muted p-4">Loading...</div>}>
              <HistoryView />
            </Suspense>
          </div>
        )}

        {activeSection === "cost" && (
          <div className="grid grid-cols-2 gap-4 max-w-2xl">
            <CostCard />
          </div>
        )}

        {activeSection === "dictation" && (
          <div className="max-w-2xl">
            <DictationCard />
          </div>
        )}
      </div>

    </div>
  );
}

const CATEGORIES: PromptTemplate["category"][] = ["general", "debugging", "review", "feature", "custom"];

function PromptTemplatesCard() {
  const templates = usePromptStore((s) => s.templates);
  const addTemplate = usePromptStore((s) => s.addTemplate);
  const deleteTemplate = usePromptStore((s) => s.deleteTemplate);

  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState<PromptTemplate["category"]>("general");

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
        <button
          onClick={() => setShowNew(!showNew)}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent-green hover:bg-accent-green/10 rounded transition-colors"
        >
          <Plus size={11} />
          New
        </button>
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
              <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
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
                <p className="text-[10px] text-text-muted line-clamp-2">
                  {t.content}
                </p>
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
    </div>
  );
}
