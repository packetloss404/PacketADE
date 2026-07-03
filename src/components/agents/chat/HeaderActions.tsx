import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { AgentModeChip, type AgentMode } from "../AgentModeChip";
import { ContextUsageRing } from "../ContextUsageRing";
import { DiffPaneTrigger } from "../DiffPaneTrigger";
import { ModelSelector } from "../composer/ModelSelector";
import { useOllamaModels } from "../hooks/useOllamaModels";
import { HeaderOverflowMenu } from "./HeaderOverflowMenu";
import type { AgentConversation } from "@/types/agent-conversation";
import { addPaneControlListener, OPEN_MODEL_DROPDOWN_EVENT } from "../paneEvents";

interface HeaderActionsProps {
  conversation: AgentConversation;
  conversationId: string;
  diffTotals: { fileCount: number; totalAdds: number; totalDels: number };
  previewOpen: boolean;
  togglePreview: () => void;
  onClose: () => void;
  onCycleMode: () => void;
  onSelectMode: (mode: AgentMode) => void;
  onSetApproveWrites: (on: boolean) => void;
  onChangeModel: (model: string) => void;
  onExport: () => void;
}

/**
 * Chat header's resting right cluster — consolidated to six controls (P1-10):
 * AgentModeChip, model picker, ContextUsageRing, the Changes chip
 * (DiffPaneTrigger), the overflow menu, and close. Everything else that used
 * to stand on its own (verbosity, memory, preview toggle, export items,
 * Continue-in, the raw model Dropdown) lives inside HeaderOverflowMenu now,
 * or — for the model picker — reuses the composer's ModelSelector so
 * ctx/pricing metadata appears here too.
 */
export function HeaderActions({
  conversation,
  conversationId,
  diffTotals,
  previewOpen,
  togglePreview,
  onClose,
  onCycleMode,
  onSelectMode,
  onSetApproveWrites,
  onChangeModel,
  onExport,
}: HeaderActionsProps) {
  const { ollamaModels, refresh: refreshOllamaModels } = useOllamaModels(
    conversation.agent,
  );
  // `/model` slash command → bump the signal so the model dropdown opens.
  const [modelOpenSignal, setModelOpenSignal] = useState(0);
  useEffect(
    () =>
      addPaneControlListener(OPEN_MODEL_DROPDOWN_EVENT, conversationId, () =>
        setModelOpenSignal((n) => n + 1),
      ),
    [conversationId],
  );

  return (
    <div className="flex items-center gap-1 shrink-0">
      {conversation.mode === "api" && (
        <>
          <AgentModeChip
            conversation={conversation}
            onCycle={onCycleMode}
            onSelectMode={onSelectMode}
            onSetApproveWrites={onSetApproveWrites}
          />
          <ModelSelector
            selectedAgent={conversation.agent}
            selectedModel={conversation.model ?? ""}
            onModelChange={onChangeModel}
            ollamaModels={ollamaModels}
            refreshOllamaModels={refreshOllamaModels}
            openSignal={modelOpenSignal}
          />
          <ContextUsageRing conversation={conversation} />
          <DiffPaneTrigger
            conversationId={conversationId}
            fileCount={diffTotals.fileCount}
            totalAdds={diffTotals.totalAdds}
            totalDels={diffTotals.totalDels}
          />
        </>
      )}

      <HeaderOverflowMenu
        conversation={conversation}
        previewOpen={previewOpen}
        togglePreview={togglePreview}
        onExport={onExport}
      />

      <Tooltip content="Back to list">
        <button
          onClick={onClose}
          className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors"
          aria-label="Back to list"
        >
          <X size={12} />
        </button>
      </Tooltip>
    </div>
  );
}
