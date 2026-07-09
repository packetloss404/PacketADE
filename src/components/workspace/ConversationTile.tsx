import { useContext, useEffect, useRef, useState } from "react";
import {
  Archive,
  GripHorizontal,
  Maximize2,
  Minimize2,
  MoreVertical,
} from "lucide-react";
import { MosaicWindowContext } from "react-mosaic-component";
import { AgentChatPane } from "@/components/agents/AgentChatPane";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useReviewStore } from "@/stores/reviewStore";
import { getAgentColor } from "@/lib/agentColors";
import type { WorkspacePane as WorkspacePaneType } from "@/types/workspace";

interface ConversationTileProps {
  pane: WorkspacePaneType;
  workspaceId: string;
}

const STATUS_PILL: Record<string, { label: string; className: string }> = {
  active: { label: "active", className: "bg-accent-soft text-accent-green" },
  idle: { label: "idle", className: "bg-bg-elevated text-text-muted" },
  done: { label: "done", className: "bg-accent-soft text-accent-blue" },
  failed: { label: "failed", className: "bg-bg-elevated text-accent-red" },
};

/**
 * Conversation tile (P3-S2). A thin wrapper that mounts the UNFORKED
 * AgentChatPane inside the workspace mosaic. It owns only tile-layer concerns —
 * mosaic drag/zoom chrome, the pointer-down focus arm that drives the Y/N
 * keyboard gate, and the review auto-zoom — while the conversation experience
 * itself is AgentChatPane verbatim (two additive props: `frame`,
 * `keyboardScopeActive`; no fork, no extraction).
 *
 * Interim visual parity with terminal tiles (grip, color dot, title, status
 * pill, zoom in the same positions) is provided by the chrome bar below; the
 * shared-header-grammar extraction is deferred post-retirement per the ruling.
 */
export function ConversationTile({ pane, workspaceId }: ConversationTileProps) {
  // A conversation pane always carries a string conversationId (enforced by
  // normalizePanes — a stripped id self-heals to a terminal pane, so it never
  // reaches this branch). The `?? ""` keeps TS honest and makes AgentChatPane
  // render its own "not found" fallback in the impossible case.
  const conversationId = pane.conversationId ?? "";

  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );

  const activePaneId = useLayoutStore((s) => s.activePaneId);
  const setActivePaneId = useLayoutStore((s) => s.setActivePaneId);
  const zoomedPaneId = useWorkspaceStore((s) => s.zoomedPaneId);
  const setZoomedPane = useWorkspaceStore((s) => s.setZoomedPane);
  const isFocused = activePaneId === pane.id;
  const isZoomed = zoomedPaneId === pane.id;

  const [showOverflow, setShowOverflow] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Canonical review surface open-state, scoped to this tile's conversation.
  const reviewOpen = useReviewStore(
    (s) => s.open && s.conversationId === conversationId,
  );

  // Auto-zoom on review (autoZoomedBy bookkeeping, kept as a local ref in the
  // tile layer per the sprint). ReviewSurface must NEVER render at raw tile
  // width, so opening review CSS-maximizes this tile via the EXISTING
  // setZoomedPane (siblings visibility:hidden, nothing remounts — PTY/P0-2
  // law). The ref records whether *review* caused the zoom so closing review
  // un-zooms only in that case — a manual zoom the user set before opening
  // review is left intact.
  const autoZoomedByReview = useRef(false);
  useEffect(() => {
    if (reviewOpen) {
      if (useWorkspaceStore.getState().zoomedPaneId !== pane.id) {
        setZoomedPane(pane.id);
        autoZoomedByReview.current = true;
      }
    } else if (autoZoomedByReview.current) {
      autoZoomedByReview.current = false;
      if (useWorkspaceStore.getState().zoomedPaneId === pane.id) {
        setZoomedPane(null);
      }
    }
  }, [reviewOpen, pane.id, setZoomedPane]);

  // Close the overflow menu on outside click.
  useEffect(() => {
    if (!showOverflow) return;
    const handler = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showOverflow]);

  // Reach the mosaic drag source so the chrome bar reorders tiles, mirroring
  // WorkspacePane's convention.
  const mosaicCtx = useContext(MosaicWindowContext);
  const mosaicWindowActions = mosaicCtx?.mosaicWindowActions ?? null;

  // X removes the PANE ONLY — the conversation survives as an unplaced fleet
  // row (Bravo conceded close-as-archive conflated layout with lifecycle).
  const removeTile = () => {
    useWorkspaceStore.getState().removePane(workspaceId, pane.id);
  };

  // Archive is the explicit lifecycle action (overflow), distinct from X.
  const archiveConversation = () => {
    if (conversationId) {
      useAgentTaskStore.getState().archiveConversation(conversationId);
    }
    setShowOverflow(false);
    removeTile();
  };

  const color = getAgentColor(conversation?.agent ?? "");
  const title = conversation?.title || "Conversation";
  const isActive = conversation?.status === "active";
  const pill = STATUS_PILL[conversation?.status ?? "idle"] ?? STATUS_PILL.idle;

  const chrome = (
    <div
      className="flex cursor-grab select-none items-center gap-2 border-b border-line-soft bg-bg-secondary px-2 py-1 active:cursor-grabbing"
      onDoubleClick={() => setZoomedPane(isZoomed ? null : pane.id)}
    >
      <GripHorizontal size={11} className="shrink-0 text-text-muted" />
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${color.text} bg-current ${isActive ? "animate-pulse motion-reduce:animate-none" : ""}`}
      />
      <span className={`truncate text-ui font-semibold ${color.text}`}>{title}</span>
      <div className="flex-1" />
      <span className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-meta ${pill.className}`}>
        {pill.label}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setZoomedPane(isZoomed ? null : pane.id);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="shrink-0 p-0.5 text-text-muted transition-colors hover:text-accent-blue"
        title={isZoomed ? "Exit zoom (Esc)" : "Zoom to focus"}
      >
        {isZoomed ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
      </button>
      <div ref={overflowRef} className="relative shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowOverflow((v) => !v);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="p-0.5 text-text-muted transition-colors hover:text-text-primary"
          title="More"
        >
          <MoreVertical size={11} />
        </button>
        {showOverflow && (
          <div
            className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-bg-border bg-bg-elevated py-1 shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                archiveConversation();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-text-primary transition-colors hover:bg-bg-hover"
            >
              <Archive size={12} />
              Archive conversation
            </button>
          </div>
        )}
      </div>
    </div>
  );

  const connectedChrome = mosaicWindowActions?.connectDragSource(chrome) ?? chrome;

  const wrapperBorderClass = isFocused ? "border border-accent-line" : "border border-bg-border";

  return (
    // data-pane-zoomed lets mosaic-overrides.css maximize this tile's
    // already-mounted mosaic tile when zoomed (.mosaic-zoom-active) — the same
    // CSS path terminal tiles use, so no sibling ever remounts.
    // onPointerDown arms the Y/N keyboard gate (activePaneId === pane.id),
    // mirroring TerminalPane's focus convention (which uses onClick) but at
    // pointer-down so focus is set before any subsequent keydown.
    <div
      data-pane-zoomed={isZoomed || undefined}
      onPointerDown={() => {
        if (!isFocused) setActivePaneId(pane.id);
      }}
      className={`flex h-full flex-col overflow-hidden rounded-md ${wrapperBorderClass}`}
    >
      {connectedChrome}
      <div className="min-h-0 flex-1">
        <AgentChatPane
          conversationId={conversationId}
          onClose={removeTile}
          frame="tile"
          keyboardScopeActive={isFocused}
        />
      </div>
    </div>
  );
}
