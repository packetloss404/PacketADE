import { useCallback, useEffect, useState, useRef } from "react";
import { Mosaic, MosaicWindow } from "react-mosaic-component";
import { Minimize2 } from "lucide-react";
import type { MosaicNode, MosaicPath } from "@/types/mosaic";
import { WorkspacePane } from "./WorkspacePane";
import type { Workspace } from "@/types/workspace";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { buildPresetTree, presetForCount } from "@/lib/mosaicPresets";

interface WorkspaceMosaicContainerProps {
  workspace: Workspace;
}

/**
 * Mosaic tiling container for workspace multi-agent grids.
 * Each workspace gets its own ephemeral mosaic tree.
 */
export function WorkspaceMosaicContainer({ workspace }: WorkspaceMosaicContainerProps) {
  const [tree, setTree] = useState<MosaicNode<string> | null>(null);
  const prevWorkspaceIdRef = useRef<string | null>(null);
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

  // Build tree when workspace changes
  useEffect(() => {
    if (prevWorkspaceIdRef.current === workspace.id) return;
    prevWorkspaceIdRef.current = workspace.id;

    const paneIds = workspace.panes.map((p) => p.id);
    if (paneIds.length === 0) {
      setTree(null);
    } else if (paneIds.length === 1) {
      setTree(paneIds[0]);
    } else {
      setTree(buildPresetTree(presetForCount(paneIds.length), paneIds));
    }
  }, [workspace.id, workspace.panes]);

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
        {/* Mosaic layout — hidden when a pane is zoomed but kept mounted to preserve state */}
        <div className={zoomedPane ? "invisible absolute inset-0" : "contents"}>
          <Mosaic<string>
            renderTile={renderTile}
            value={tree}
            onChange={handleChange}
            className=""
          />
        </div>

        {/* Zoomed pane overlay */}
        {zoomedPane && (
          <div className="absolute inset-0 z-10 flex flex-col bg-bg-primary">
            <WorkspacePane pane={zoomedPane} workspaceId={workspace.id} />
            <div className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5 px-2 py-1 rounded bg-bg-secondary/90 border border-bg-border text-[10px] text-text-muted select-none">
              <Minimize2 size={10} />
              <span>Press Esc to exit zoom</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
