import { useCallback, useEffect, useState, useRef } from "react";
import { Mosaic, MosaicWindow } from "react-mosaic-component";
import { Minimize2 } from "lucide-react";
import type { MosaicNode, MosaicPath } from "@/types/mosaic";
import { WorkspacePane } from "./WorkspacePane";
import { ConversationTile } from "./ConversationTile";
import { FileTile } from "./FileTile";
import type { Workspace } from "@/types/workspace";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useReviewStore } from "@/stores/reviewStore";
import {
  buildPresetTree,
  presetForCount,
  appendPane,
  removeFromTree,
  getLeafOrder,
} from "@/lib/mosaicPresets";

interface WorkspaceMosaicContainerProps {
  workspace: Workspace;
  /** Permit initial PTY startup only for the visible, selected Workspace. */
  autoStartTerminals?: boolean;
}

/**
 * Mosaic tiling container for workspace multi-agent grids.
 * Each workspace gets its own ephemeral mosaic tree.
 */
export function WorkspaceMosaicContainer({
  workspace,
  autoStartTerminals = true,
}: WorkspaceMosaicContainerProps) {
  const [tree, setTree] = useState<MosaicNode<string> | null>(null);
  const prevPaneKeyRef = useRef<string>("");
  const zoomedPaneId = useWorkspaceStore((s) => s.zoomedPaneId);
  const setZoomedPane = useWorkspaceStore((s) => s.setZoomedPane);

  // Clear zoom when workspace changes
  useEffect(() => {
    setZoomedPane(null);
  }, [workspace.id, setZoomedPane]);

  // Escape key exits zoom — condition-based Escape layering (P3-S1, Alpha's
  // ruled version). Explicit condition check, NOT defaultPrevented ordering:
  // while the canonical review surface is open the zoom-exit no-ops so a
  // single Escape closes review first (ReviewSurface owns that Escape) and
  // leaves the auto-zoom intact. Review and zoom-exit therefore never
  // double-fire off one keypress. A later Escape (review closed) exits zoom.
  useEffect(() => {
    if (!zoomedPaneId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // No-op while review is open — the review layer consumes this Escape.
      if (useReviewStore.getState().open) return;
      e.preventDefault();
      e.stopPropagation();
      setZoomedPane(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomedPaneId, setZoomedPane]);

  // Sync the mosaic tree with persisted Workspace panes.
  // Uses a stable paneKey string to detect actual changes and avoid double-fires.
  const paneKey = workspace.panes.map((p) => p.id).join(",");
  useEffect(() => {
    // Skip if the set of pane IDs hasn't actually changed
    if (paneKey === prevPaneKeyRef.current) return;

    const prevIds = prevPaneKeyRef.current ? prevPaneKeyRef.current.split(",") : [];
    const nextIds = paneKey ? paneKey.split(",") : [];
    prevPaneKeyRef.current = paneKey;

    if (nextIds.length === 0 || (nextIds.length === 1 && nextIds[0] === "")) {
      setTree(null);
      return;
    }
    // No single-pane special case: a bare-leaf root would have to be wrapped
    // in a split when the second pane arrives, and wrapping changes the first
    // pane's depth — which remounts it and restarts its agent. `buildPresetTree`
    // returns a split even for one pane so growth is always a plain append.

    setTree((currentTree) => {
      // If no previous tree or workspace switched, full rebuild
      if (!currentTree || prevIds.length === 0) {
        return buildPresetTree(presetForCount(nextIds.length), nextIds);
      }

      const currentLeaves = new Set(getLeafOrder(currentTree));
      const nextSet = new Set(nextIds);

      // Find added and removed panes
      const added = nextIds.filter((id) => !currentLeaves.has(id));
      const removed = [...currentLeaves].filter((id) => !nextSet.has(id));

      let updated: MosaicNode<string> | null = currentTree;

      // Remove panes first
      for (const id of removed) {
        if (updated) updated = removeFromTree(updated, id);
      }

      // Add new panes. Appending to the root split keeps every surviving leaf
      // at its exact depth, so no running pane is remounted (and no live PTY
      // killed and restarted) just because a sibling was added.
      for (const newId of added) {
        updated = updated ? appendPane(updated, newId) : buildPresetTree("1x1", [newId]);
      }

      return updated;
    });
  }, [paneKey]);

  const handleChange = useCallback((newTree: MosaicNode<string> | null) => {
    setTree(newTree);
  }, []);

  const renderTile = useCallback(
    (id: string, path: MosaicPath) => {
      const pane = workspace.panes.find((p) => p.id === id);
      if (pane) {
        return (
          <MosaicWindow<string>
            path={path}
            title={pane.agentId}
            toolbarControls={<></>}
            renderToolbar={null}
            draggable
          >
            {/* One branch on pane.kind (P3-S2): conversation panes mount the
                ConversationTile (unforked AgentChatPane), file panes mount the
                FileTile (unforked EditorPane); everything else is a terminal
                pane. `kind` is the sole discriminant. */}
            {pane.kind === "conversation" ? (
              <ConversationTile pane={pane} workspaceId={workspace.id} />
            ) : pane.kind === "file" ? (
              <FileTile
                pane={pane}
                projectPath={workspace.projectPath}
                remote={Boolean(workspace.serverId)}
              />
            ) : (
              <WorkspacePane
                pane={pane}
                workspaceId={workspace.id}
                autoStart={autoStartTerminals}
              />
            )}
          </MosaicWindow>
        );
      }

      return <div />;
    },
    [autoStartTerminals, workspace],
  );

  // Find the zoomed pane (if it belongs to this workspace)
  const zoomedPane = zoomedPaneId ? workspace.panes.find((p) => p.id === zoomedPaneId) : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="relative flex-1 overflow-hidden">
        {/* Zoom maximizes the ALREADY-MOUNTED tile via CSS (see
            mosaic-overrides.css: .mosaic-zoom-active) instead of mounting a
            second WorkspacePane — a duplicate pane instance would auto-start
            a second agent PTY for the same pane, clobbering setPaneSession
            and orphaning the original session on unmount. Non-zoomed tiles
            stay mounted (hidden) so every PTY survives zoom in/out. */}
        <Mosaic<string>
          renderTile={renderTile}
          value={tree}
          onChange={handleChange}
          className={zoomedPane ? "mosaic-zoom-active" : ""}
        />

        {zoomedPane && (
          <div className="bg-bg-secondary/90 absolute bottom-3 right-3 z-20 flex select-none items-center gap-1.5 rounded border border-bg-border px-2 py-1 text-meta text-text-muted">
            <Minimize2 size={10} />
            <span>Press Esc to exit zoom</span>
          </div>
        )}
      </div>
    </div>
  );
}
