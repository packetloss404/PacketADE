import { ChevronRight, MessageSquare } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";
import { getDefaultModel } from "@/lib/api-models";
import { SCOUT_SYSTEM_PROMPT, SCOUT_ALLOWED_TOOLS, SCOUT_MEMORY_CONTEXT_DEFAULT } from "@/lib/scout-config";
import type { Idea } from "@/types/ideation";
import { getTypeConfig, SEVERITY_COLORS, EFFORT_COLORS } from "./ideationConfig";

interface IdeaCardProps {
  idea: Idea;
  isSelected: boolean;
  onSelect: () => void;
}

export function IdeaCard({ idea, isSelected, onSelect }: IdeaCardProps) {
  const { icon: TypeIcon, color: typeColor } = getTypeConfig(idea.type);

  async function handleAskScout(e: React.MouseEvent) {
    e.stopPropagation();
    const workspace = useWorkspaceStore.getState().getActiveWorkspace();
    if (!workspace) return;
    const agent = "api-claude";
    const id = await useAgentTaskStore.getState().createApiConversation({
      agent,
      projectPath: workspace.projectPath,
      model: getDefaultModel(agent),
      initialMessage: `Tell me more about this idea: ${idea.title}\n\n${idea.description}`,
      systemPromptOverride: SCOUT_SYSTEM_PROMPT,
      thinkingEnabled: false,
      planMode: false,
      sshTarget: null,
      skipBackendStart: false,
      allowedTools: SCOUT_ALLOWED_TOOLS,
      memoryContextEnabled: SCOUT_MEMORY_CONTEXT_DEFAULT,
    });
    useAgentTaskStore.getState().selectConversation(id);
    useAppStore.getState().setActiveView("agents");
  }

  return (
    <div
      onClick={onSelect}
      className={`p-3 rounded-lg border cursor-pointer transition-all ${
        isSelected
          ? "bg-bg-elevated border-accent-green/30"
          : idea.status === "converted"
          ? "bg-bg-secondary/50 border-bg-border opacity-60"
          : "bg-bg-secondary border-bg-border hover:border-bg-hover"
      }`}
    >
      <div className="flex items-start gap-2">
        <TypeIcon size={14} className={`${typeColor} mt-0.5 flex-shrink-0`} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-text-primary truncate">{idea.title}</p>
          <p className="text-[11px] text-text-muted mt-0.5 line-clamp-2">{idea.description}</p>
          <div className="flex items-center gap-1.5 mt-2">
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${SEVERITY_COLORS[idea.severity] || ""}`}>
              {idea.severity}
            </span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${EFFORT_COLORS[idea.effort] || ""}`}>
              {idea.effort}
            </span>
            {idea.status === "converted" && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-accent-green/20 text-accent-green">converted</span>
            )}
            {idea.affectedFiles.length > 0 && (
              <span className="text-[9px] text-text-muted ml-auto">
                {idea.affectedFiles.length} file{idea.affectedFiles.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={handleAskScout}
          title="Ask Scout (read-only agent with project memory)"
          className="p-1 rounded text-text-muted hover:text-accent-cyan hover:bg-accent-cyan/10 flex-shrink-0 transition-colors"
        >
          <MessageSquare size={11} />
        </button>
        <ChevronRight size={12} className={`text-text-muted flex-shrink-0 transition-transform ${isSelected ? "rotate-90" : ""}`} />
      </div>
    </div>
  );
}
