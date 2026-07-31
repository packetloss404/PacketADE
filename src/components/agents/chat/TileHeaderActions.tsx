import { useEffect, useState } from "react";
import { ChevronDown, MoreVertical, X } from "lucide-react";
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
  /** Archive this conversation from the overflow menu. Absent → no Archive row
   * (the Agents view keeps lifecycle actions on the sidebar row). */
  onArchive?: () => void;
  /** Accessible name of the close (X) control. Must describe what closing
   * actually does at THIS mount site. */
  closeLabel?: string;
  /** Tooltip for the close control — states the consequence in full. */
  closeTooltip?: string;
}

/**
 * Tile-frame ("frame='tile'") variant of the chat header's right cluster —
 * the responsive + lazy-mount economy required by the N-tile mosaic (P3-S3).
 *
 * Ruled hybrid responsive model (no ResizeObserver, no width JS):
 *  - CSS `@container` (see `src/styles/conversation-tile.css`) handles ALL
 *    *visual* collapse of the cheap always-mounted set at narrow widths.
 *  - The heavy controls — `ModelSelector` and `ContextUsageRing` — MOUNT
 *    LAZILY, only when revealed from the overflow menu or when this tile is the
 *    zoomed pane. Both are already-existing JS state (local reveal state +
 *    `workspaceStore.zoomedPaneId`), so a resting narrow tile pays zero cost
 *    for them and mounts NO observers.
 *  - `HeaderOverflowMenu` is the header's ONE menu (the old second kebab that
 *    toggled the inline cluster is now a row inside it). It also mounts on
 *    first use: until then an identical-looking placeholder button holds its
 *    slot, and its click mounts the menu already open.
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
  onArchive,
  // Defaults describe the Agents-view mount (AgentChatPane's onClose there
  // deselects the conversation and shows the New agent screen). The workspace
  // tile passes its own pair — closing a tile removes the pane, not the chat.
  closeLabel = "Close conversation",
  closeTooltip = "Close conversation — returns to the New agent screen. Nothing is stopped or deleted; it stays in the list.",
}: TileHeaderActionsProps) {
  const isApi = conversation.mode === "api";

  const { ollamaModels, refresh: refreshOllamaModels } = useOllamaModels(
    conversation.agent,
  );

  // Inline model/context cluster reveal — now toggled from a row INSIDE the
  // overflow menu (it used to be a second kebab beside the menu's own).
  const [inlineControls, setInlineControls] = useState(false);
  // The overflow menu itself mounts on first use (or when this tile is zoomed);
  // until then a look-alike placeholder holds its place, so the header always
  // shows exactly ONE menu control and never shifts.
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuOpenSignal, setMenuOpenSignal] = useState(0);

  // `/model` slash command → reveal the cluster (mounting the picker) and bump
  // the signal so the model dropdown opens.
  const [modelOpenSignal, setModelOpenSignal] = useState(0);
  useEffect(
    () =>
      addPaneControlListener(OPEN_MODEL_DROPDOWN_EVENT, conversationId, () => {
        setInlineControls(true);
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

  const heavyMounted = inlineControls || isZoomedTile;
  const menuActive = menuMounted || isZoomedTile;

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
      {/* The ONE overflow menu of this header. Mounted on first use; the
          placeholder below is its visual stand-in until then. */}
      {menuActive ? (
        <HeaderOverflowMenu
          conversation={conversation}
          previewOpen={previewOpen}
          togglePreview={togglePreview}
          onExport={onExport}
          openSignal={menuOpenSignal}
          inlineControlsShown={heavyMounted}
          onToggleInlineControls={
            isApi && !isZoomedTile ? () => setInlineControls((v) => !v) : undefined
          }
          onArchive={onArchive}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setMenuMounted(true);
            setMenuOpenSignal((n) => n + 1);
          }}
          aria-label="Conversation menu"
          aria-haspopup="menu"
          className="flex items-center gap-1 rounded px-2 py-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <span className="inline-flex p-0.5">
            <MoreVertical size={12} />
          </span>
          <ChevronDown size={10} />
        </button>
      )}

      <Tooltip content={closeTooltip}>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-text-muted transition-colors hover:text-text-primary"
          aria-label={closeLabel}
        >
          <X size={12} />
        </button>
      </Tooltip>
    </div>
  );
}
