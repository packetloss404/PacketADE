import { useCallback, useEffect, useState, useRef } from "react";
import { Mosaic, MosaicWindow } from "react-mosaic-component";
import type { MosaicNode, MosaicPath } from "@/types/mosaic";
import { WorkspacePane } from "./WorkspacePane";
import { MosaicTile } from "@/components/layout/MosaicTile";
import type { Workspace } from "@/types/workspace";
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
          <MosaicTile paneId={id}>
            <WorkspacePane pane={pane} workspaceId={workspace.id} />
          </MosaicTile>
        </MosaicWindow>
      );
    },
    [workspace.panes, workspace.id],
  );

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 relative overflow-hidden">
        <Mosaic<string>
          renderTile={renderTile}
          value={tree}
          onChange={handleChange}
          className=""
        />
      </div>
    </div>
  );
}
