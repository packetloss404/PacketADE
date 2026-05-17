import {
  Compass,
  Download,
  FileCheck2,
  MoreVertical,
  PanelRightOpen,
  RotateCcw,
  X,
} from "lucide-react";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { AgentModeChip } from "../AgentModeChip";
import { ContextUsageRing } from "../ContextUsageRing";
import { ContinueInMenu } from "../ContinueInMenu";
import { DiffPaneTrigger } from "../DiffPaneTrigger";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { API_PROVIDERS } from "@/lib/api-models";
import type { AgentConversation } from "@/types/agent-conversation";

interface HeaderActionsProps {
  conversation: AgentConversation;
  conversationId: string;
  diffTotals: { fileCount: number; totalAdds: number; totalDels: number };
  previewOpen: boolean;
  togglePreview: () => void;
  showRewind: boolean;
  setShowRewind: (updater: (v: boolean) => boolean) => void;
  onClose: () => void;
  onCycleMode: () => void;
  onChangeModel: (model: string) => void;
  setPlanMode: (id: string, on: boolean) => Promise<void> | void;
  setPermissionMode: (
    id: string,
    mode: "auto" | "ask_for_risky" | "allow_all" | "deny_all",
  ) => Promise<void> | void;
  setApproveWrites: (id: string, on: boolean) => Promise<void> | void;
  onExport: () => void;
}

export function HeaderActions({
  conversation,
  conversationId,
  diffTotals,
  previewOpen,
  togglePreview,
  showRewind,
  setShowRewind,
  onClose,
  onCycleMode,
  onChangeModel,
  setPlanMode,
  setPermissionMode,
  setApproveWrites,
  onExport,
}: HeaderActionsProps) {
  const memoryGetContext = useMemoryStore((s) => s.getContextForSession);
  const providerInfo = API_PROVIDERS.find(
    (p) => p.agentCli === conversation.agent,
  );
  const currentModelValue = conversation.model ?? "";
  const currentModelLabel =
    providerInfo?.models.find((m) => m.value === currentModelValue)?.label ??
    currentModelValue ??
    "Model";

  return (
    <div className="flex items-center gap-1 shrink-0">
      {conversation.mode === "api" && (
        <select
          value={conversation.transcriptVerbosity ?? "normal"}
          onChange={(e) => {
            const next = e.target.value as "summary" | "normal" | "verbose";
            useAgentTaskStore.setState((s) => ({
              conversations: s.conversations.map((c) =>
                c.id === conversationId
                  ? { ...c, transcriptVerbosity: next, updatedAt: Date.now() }
                  : c,
              ),
            }));
          }}
          title="Transcript density: Summary collapses tool calls and hides thinking; Verbose shows raw inputs."
          className="bg-bg-secondary border border-bg-border rounded text-[10px] px-1 py-0.5 text-text-secondary"
        >
          <option value="summary">Summary</option>
          <option value="normal">Normal</option>
          <option value="verbose">Verbose</option>
        </select>
      )}

      {conversation.mode === "api" && (
        <button
          onClick={() => {
            useAgentTaskStore.setState((s) => ({
              conversations: s.conversations.map((c) =>
                c.id === conversationId
                  ? {
                      ...c,
                      memoryContextEnabled: !(c.memoryContextEnabled ?? false),
                      updatedAt: Date.now(),
                    }
                  : c,
              ),
            }));
          }}
          title={
            conversation.memoryContextEnabled
              ? (() => {
                  const ctx = memoryGetContext(conversation.projectPath);
                  if (!ctx.trim()) {
                    return "Memory context ON — no patterns learned yet for this project";
                  }
                  const preview =
                    ctx.length > 600 ? `${ctx.slice(0, 600)}…` : ctx;
                  return `Memory context ON — injecting:\n\n${preview}`;
                })()
              : "Memory context OFF — click to include learned patterns in system prompt"
          }
          className={`border rounded px-1.5 py-0.5 text-[10px] transition-colors ${
            conversation.memoryContextEnabled
              ? "bg-accent-blue/15 border-accent-blue/40 text-accent-blue"
              : "bg-bg-secondary border-bg-border text-text-muted hover:text-text-secondary"
          }`}
        >
          Memory
        </button>
      )}

      {conversation.mode === "api" && (
        <ContextUsageRing conversation={conversation} />
      )}

      {providerInfo && conversation.mode === "api" && (
        <div data-agent-pane-model-dropdown={conversationId}>
          <Dropdown
            align="right"
            trigger={
              <span className="text-[11px] text-text-secondary">
                {currentModelLabel}
              </span>
            }
          >
            {providerInfo.models.map((m) => (
              <DropdownItem
                key={m.value}
                onClick={() => onChangeModel(m.value)}
              >
                <span
                  className={
                    m.value === currentModelValue
                      ? "text-accent-green text-[11px]"
                      : "text-[11px]"
                  }
                >
                  {m.label}
                </span>
              </DropdownItem>
            ))}
          </Dropdown>
        </div>
      )}

      {conversation.mode === "api" && (
        <div className="flex items-center gap-1.5">
          <AgentModeChip conversation={conversation} onCycle={onCycleMode} />
          <button
            type="button"
            onClick={() => void setPlanMode(conversationId, !conversation.planMode)}
            title={
              conversation.planMode
                ? "Plan mode ON — writes/bash disabled"
                : "Plan mode OFF — all tools enabled"
            }
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
              conversation.planMode
                ? "border-accent-amber/40 text-accent-amber bg-accent-amber/10"
                : "border-bg-border text-text-muted hover:text-text-primary"
            }`}
          >
            <Compass size={11} />
            Plan
          </button>
          <div data-agent-pane-permissions-dropdown={conversationId}>
            <select
              value={conversation.permissionMode ?? "auto"}
              onChange={(e) =>
                void setPermissionMode(
                  conversationId,
                  e.target.value as
                    | "auto"
                    | "ask_for_risky"
                    | "allow_all"
                    | "deny_all",
                )
              }
              title="Permission mode for risky tools"
              className="bg-bg-secondary border border-bg-border rounded text-[10px] px-1 py-0.5 text-text-secondary"
            >
              <option value="auto">Auto</option>
              <option value="ask_for_risky">Ask risky</option>
              <option value="allow_all">Allow all</option>
              <option value="deny_all">Deny risky</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() =>
              void setApproveWrites(conversationId, !conversation.approveWrites)
            }
            title={
              conversation.approveWrites
                ? "Approve writes ON — confirm each write_file"
                : "Approve writes OFF"
            }
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors ${
              conversation.approveWrites
                ? "border-accent-amber/40 text-accent-amber bg-accent-amber/10"
                : "border-bg-border text-text-muted hover:text-text-primary"
            }`}
          >
            <FileCheck2 size={11} />
            Approve
          </button>
          <Dropdown
            align="right"
            trigger={
              <span className="p-0.5 text-text-muted hover:text-text-primary inline-flex">
                <MoreVertical size={12} />
              </span>
            }
          >
            <DropdownItem onClick={onExport}>
              <span className="flex items-center gap-1.5 text-[11px]">
                <Download size={11} /> Export as Markdown
              </span>
            </DropdownItem>
          </Dropdown>
        </div>
      )}

      {conversation.mode === "api" && (
        <DiffPaneTrigger
          conversationId={conversationId}
          fileCount={diffTotals.fileCount}
          totalAdds={diffTotals.totalAdds}
          totalDels={diffTotals.totalDels}
        />
      )}

      <button
        type="button"
        onClick={togglePreview}
        className={`p-0.5 rounded transition-colors ${
          previewOpen
            ? "text-accent-blue bg-accent-blue/10"
            : "text-text-muted hover:text-text-primary"
        }`}
        title={previewOpen ? "Collapse preview pane" : "Open preview pane"}
        aria-label={previewOpen ? "Collapse preview pane" : "Open preview pane"}
      >
        <PanelRightOpen size={12} />
      </button>

      <ContinueInMenu conversation={conversation} />

      <button
        onClick={() => setShowRewind((v) => !v)}
        className={`p-0.5 rounded transition-colors ${
          showRewind
            ? "text-accent-blue"
            : "text-text-muted hover:text-text-primary"
        }`}
        title="Rewind / checkpoints"
      >
        <RotateCcw size={12} />
      </button>

      <button
        onClick={onClose}
        className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors"
        title="Close pane"
      >
        <X size={12} />
      </button>
    </div>
  );
}
