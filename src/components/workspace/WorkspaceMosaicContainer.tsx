import { useCallback, useEffect, useState, useRef } from "react";
import { Mosaic, MosaicWindow } from "react-mosaic-component";
import { Minimize2 } from "lucide-react";
import type { MosaicNode, MosaicPath } from "@/types/mosaic";
import { WorkspacePane } from "./WorkspacePane";
import type { Workspace } from "@/types/workspace";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { buildPresetTree, presetForCount, addToTree, removeFromTree, getLeafOrder } from "@/lib/mosaicPresets";

interface WorkspaceMosaicContainerProps {
  workspace: Workspace;
}

/**
 * Mosaic tiling container for workspace multi-agent grids.
 * Each workspace gets its own ephemeral mosaic tree.
 */
export function WorkspaceMosaicContainer({ workspace }: WorkspaceMosaicContainerProps) {
  const [tree, setTree] = useState<MosaicNode<string> | null>(null);
  const prevPaneKeyRef = useRef<string>("");
  const zoomedPaneId = useWorkspaceStore((s) => s.zoomedPaneId);
  const setZoomedPane = useWorkspaceStore((s) => s.setZoomedPane);

  // Clear zoom when workspace changes
  useEffect(() => {
    setZoomedPane(null);
  }, [workspace.id, setZoomedPane]);

  // Escape key exits zoom
  useEffect(() => {
    if (!zoomedPaneId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setZoomedPane(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomedPaneId, setZoomedPane]);

  // Sync the mosaic tree with workspace panes.
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
    if (nextIds.length === 1) {
      setTree(nextIds[0]);
      return;
    }

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

      // Add new panes
      for (const newId of added) {
        if (!updated) {
          updated = newId;
        } else {
          const lastLeaf = getLeafOrder(updated).pop();
          if (lastLeaf) {
            updated = addToTree(updated, lastLeaf, newId, "row");
          }
        }
      }

      return updated;
    });
  }, [paneKey]);

  const handleChange = useCallback(
    (newTree: MosaicNode<string> | null) => {
      setTree(newTree);
    },
    [],
  );

  const renderTile = useCallback(
    (id: string, path: MosaicPath) => {
      const pane = workspace.panes.find((p) => p.id === id);
      if (!pane) return <div />;

      return (
        <MosaicWindow<string>
          path={path}
          title={pane.agentId}
          toolbarControls={<></>}
          renderToolbar={null}
          draggable
        >
          <WorkspacePane pane={pane} workspaceId={workspace.id} />
        </MosaicWindow>
      );
    },
    [workspace.panes, workspace.id],
  );

  // Find the zoomed pane (if it belongs to this workspace)
  const zoomedPane = zoomedPaneId
    ? workspace.panes.find((p) => p.id === zoomedPaneId)
    : null;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 relative overflow-hidden">
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
          <div className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5 px-2 py-1 rounded bg-bg-secondary/90 border border-bg-border text-[10px] text-text-muted select-none">
            <Minimize2 size={10} />
            <span>Press Esc to exit zoom</span>
          </div>
        )}
      </div>
    </div>
  );
}
