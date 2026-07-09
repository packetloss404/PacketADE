import { useEffect, useState } from "react";
import { MoreVertical, X } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { AgentModeChip, type AgentMode } from "../AgentModeChip";
import { ContextUsageRing } from "../ContextUsageRing";
import { DiffPaneTrigger } from "../DiffPaneTrigger";
import { ModelSelector } from "../composer/ModelSelector";
import { useOllamaModels } from "../hooks/useOllamaModels";
import { HeaderOverflowMenu } from "./HeaderOverflowMenu";
import { addPaneControlListener, OPEN_MODEL_DROPDOWN_EVENT } from "../paneEvents";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { AgentConversation } from "@/types/agent-conversation";

interface TileHeaderActionsProps {
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
  /** Pending edits + permissions for this conversation (amber approval badge). */
  pendingApprovalCount: number;
}

/**
 * Tile-frame ("frame='tile'") variant of the chat header's right cluster —
 * the responsive + lazy-mount economy required by the N-tile mosaic (P3-S3).
 *
 * Ruled hybrid responsive model (no ResizeObserver, no width JS):
 *  - CSS `@container` (see `src/styles/conversation-tile.css`) handles ALL
 *    *visual* collapse of the cheap always-mounted set at narrow widths.
 *  - The heavy controls — `ModelSelector`, `ContextUsageRing`, and the
 *    `HeaderOverflowMenu` — MOUNT LAZILY, only when the overflow toggle is open
 *    or this tile is the zoomed pane. Both are already-existing JS state
 *    (local menu open-state + `workspaceStore.zoomedPaneId`), so a resting
 *    narrow tile pays zero cost for them and mounts NO observers.
 *
 * Always-visible narrow set = three cheap per-slice subscribers: `AgentModeChip`
 * (safety posture), the Changes diffstat chip (`DiffPaneTrigger`, review entry),
 * and the amber approval badge. Close (X) is always present. This is now the
 * only chat-header right cluster — AgentChatPane mounts it directly (the retired
 * standalone AgentsView header and its `HeaderActions` router are deleted).
 */
export function TileHeaderActions({
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
  pendingApprovalCount,
}: TileHeaderActionsProps) {
  const isApi = conversation.mode === "api";

  const { ollamaModels, refresh: refreshOllamaModels } = useOllamaModels(
    conversation.agent,
  );

  // Local overflow open-state: reveals the heavy cluster inline.
  const [menuOpen, setMenuOpen] = useState(false);

  // `/model` slash command → open the cluster (mounting the picker) and bump
  // the signal so the model dropdown opens.
  const [modelOpenSignal, setModelOpenSignal] = useState(0);
  useEffect(
    () =>
      addPaneControlListener(OPEN_MODEL_DROPDOWN_EVENT, conversationId, () => {
        setMenuOpen(true);
        setModelOpenSignal((n) => n + 1);
      }),
    [conversationId],
  );

  // Is THIS conversation's tile the currently-zoomed pane? Cheap boolean
  // selector — re-renders only when the answer flips (not on every workspace
  // write). Zoomed tiles have room, so their heavy controls mount eagerly.
  const isZoomedTile = useWorkspaceStore((s) => {
    const zid = s.zoomedPaneId;
    if (!zid) return false;
    for (const ws of s.workspaces) {
      const pane = ws.panes.find((p) => p.id === zid);
      if (pane) {
        return pane.kind === "conversation" && pane.conversationId === conversationId;
      }
    }
    return false;
  });

  const heavyMounted = menuOpen || isZoomedTile;

  return (
    <div className="tile-header-actions flex shrink-0 items-center gap-1">
      {/* --- Always-visible narrow set (three cheap chips) --- */}
      {isApi && (
        <AgentModeChip
          conversation={conversation}
          onCycle={onCycleMode}
          onSelectMode={onSelectMode}
          onSetApproveWrites={onSetApproveWrites}
        />
      )}
      {isApi && (
        <DiffPaneTrigger
          conversationId={conversationId}
          fileCount={diffTotals.fileCount}
          totalAdds={diffTotals.totalAdds}
          totalDels={diffTotals.totalDels}
        />
      )}
      {pendingApprovalCount > 0 && (
        <Tooltip
          content={`${pendingApprovalCount} pending approval${pendingApprovalCount === 1 ? "" : "s"}`}
        >
          <span
            className="tile-approval-badge inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-accent-amber/20 px-1.5 py-0.5 font-mono text-meta font-semibold text-accent-amber"
            aria-label={`${pendingApprovalCount} pending approvals`}
          >
            {pendingApprovalCount}
          </span>
        </Tooltip>
      )}

      {/* --- Heavy cluster — lazily mounted (menu open OR tile zoomed) --- */}
      {isApi && heavyMounted && (
        <>
          <ModelSelector
            selectedAgent={conversation.agent}
            selectedModel={conversation.model ?? ""}
            onModelChange={onChangeModel}
            ollamaModels={ollamaModels}
            refreshOllamaModels={refreshOllamaModels}
            openSignal={modelOpenSignal}
          />
          <ContextUsageRing conversation={conversation} />
        </>
      )}
      {heavyMounted && (
        <HeaderOverflowMenu
          conversation={conversation}
          previewOpen={previewOpen}
          togglePreview={togglePreview}
          onExport={onExport}
        />
      )}

      {/* Overflow toggle — mounts/hides the heavy cluster. Redundant while the
          tile is zoomed (cluster already up) but kept for consistent chrome. */}
      <Tooltip content={menuOpen ? "Hide controls" : "More controls"}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? "Hide controls" : "More controls"}
          aria-expanded={heavyMounted}
          className="rounded p-0.5 text-text-muted transition-colors hover:text-text-primary"
        >
          <MoreVertical size={12} />
        </button>
      </Tooltip>

      <Tooltip content="Back to list">
        <button
          onClick={onClose}
          className="rounded p-0.5 text-text-muted transition-colors hover:text-text-primary"
          aria-label="Back to list"
        >
          <X size={12} />
        </button>
      </Tooltip>
    </div>
  );
}
