import { useState } from "react";
import {
  CheckSquare,
  GitBranch,
  Activity,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { PlanPanel } from "./PlanPanel";
import { EmbeddedDiffPane } from "./EmbeddedDiffPane";
import { AgentInspectorPane } from "./AgentInspectorPane";

type RailTab = "plan" | "diff" | "inspector";

interface TabDef {
  id: RailTab;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

const TABS: TabDef[] = [
  { id: "plan", label: "Plan", icon: CheckSquare },
  { id: "diff", label: "Diff", icon: GitBranch },
  { id: "inspector", label: "Inspector", icon: Activity },
];

interface AgentTabbedRailProps {
  conversationId: string;
}

/**
 * B4 — Codex-App-style right rail with Plan / Diff / Inspector tabs in a
 * single 320px column. Lighter alternative to the full mosaic split for
 * users with smaller screens. Toggle from the chat header chevron;
 * collapse-to-30px state is backed by the Agents settings store so it
 * survives reloads and can be changed from Settings.
 *
 * Active-tab choice is in-memory only (resets per mount) — matches how
 * AgentInspectorPane already handles its sub-tabs. The rail is a
 * read-only consumer; it never mutates conversation state directly.
 */
export function AgentTabbedRail({ conversationId }: AgentTabbedRailProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const [activeTab, setActiveTab] = useState<RailTab>("plan");
  const collapsed = useAgentSettingsStore((s) => s.railCollapsed);
  const setCollapsed = useAgentSettingsStore((s) => s.setRailCollapsed);

  if (!conversation) return null;

  if (collapsed) {
    return (
      <div className="shrink-0 w-8 flex flex-col items-center border-l border-bg-border bg-bg-secondary">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Expand rail"
          className="w-full h-8 flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <ChevronLeft size={12} />
        </button>
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setActiveTab(t.id);
                setCollapsed(false);
              }}
              title={t.label}
              className="w-full h-8 flex items-center justify-center text-text-muted hover:text-accent-blue hover:bg-bg-hover transition-colors"
            >
              <Icon size={12} />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="shrink-0 w-[340px] flex flex-col border-l border-bg-border bg-bg-primary">
      <div className="flex items-center h-8 border-b border-bg-border bg-bg-secondary">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-1 px-2.5 h-full text-[11px] transition-colors ${
                isActive
                  ? "bg-bg-elevated text-accent-blue border-b-2 border-accent-blue"
                  : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
              }`}
            >
              <Icon size={11} />
              {t.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="Collapse rail"
          className="ml-auto h-full w-8 flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <ChevronRight size={12} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === "plan" && <PlanPanel conversation={conversation} />}
        {activeTab === "diff" && (
          <EmbeddedDiffPane conversationId={conversationId} />
        )}
        {activeTab === "inspector" && (
          <AgentInspectorPane conversationId={conversationId} />
        )}
      </div>
    </div>
  );
}
