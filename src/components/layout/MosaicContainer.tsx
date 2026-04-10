import { useCallback, useEffect, useRef } from "react";
import { Mosaic, MosaicWindow } from "react-mosaic-component";
import type { MosaicNode, MosaicPath } from "@/types/mosaic";
import { TerminalPane } from "@/components/session/TerminalPane";
import { MosaicTile } from "./MosaicTile";
import { MosaicToolbar } from "./MosaicToolbar";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMosaicStore } from "@/stores/mosaicStore";
import {
  getLeafOrder,
  addToTree,
  removeFromTree,
  buildPresetTree,
  presetForCount,
} from "@/lib/mosaicPresets";

/**
 * Unified mosaic tiling container for CLI session panes.
 * Replaces the old PaneContainer with drag-and-drop, resize, minimize, and presets.
 */
export function MosaicContainer() {
  const panes = useLayoutStore((s) => s.panes);
  const removePane = useLayoutStore((s) => s.removePane);
  const addPane = useLayoutStore((s) => s.addPane);
  const tree = useMosaicStore((s) => s.tree);
  const setTree = useMosaicStore((s) => s.setTree);
  const updateTree = useMosaicStore((s) => s.updateTree);
  const restoreLayout = useMosaicStore((s) => s.restoreLayout);

  const prevPaneIdsRef = useRef<string[]>([]);

  // Sync: when layoutStore.panes changes, update mosaic tree
  useEffect(() => {
    const currentIds = panes.map((p) => p.id);
    const prevIds = prevPaneIdsRef.current;
    prevPaneIdsRef.current = currentIds;

    // Skip initial mount sync — handled by the init effect below
    if (prevIds.length === 0 && currentIds.length === 0) return;

    // Find added and removed panes
    const prevSet = new Set(prevIds);
    const currentSet = new Set(currentIds);
    const added = currentIds.filter((id) => !prevSet.has(id));
    const removed = prevIds.filter((id) => !currentSet.has(id));

    if (removed.length > 0) {
      let t = useMosaicStore.getState().tree;
      for (const id of removed) {
        if (t) {
          t = removeFromTree(t, id);
        }
      }
      setTree(t);
    }

    if (added.length > 0) {
      let t = useMosaicStore.getState().tree;
      for (const newId of added) {
        if (!t) {
          t = newId;
        } else {
          const activeId = useLayoutStore.getState().activePaneId;
          const leaves = getLeafOrder(t);
          const splitTarget = leaves.includes(activeId) ? activeId : leaves[leaves.length - 1];
          t = addToTree(t, splitTarget, newId, "row");
        }
      }
      setTree(t);
    }
  }, [panes, setTree]);

  // Initialize mosaic tree on first mount
  useEffect(() => {
    const currentIds = panes.map((p) => p.id);
    if (currentIds.length === 0) return;

    const restored = restoreLayout(currentIds);
    if (!restored) {
      if (currentIds.length === 1) {
        setTree(currentIds[0]);
      } else {
        setTree(buildPresetTree(presetForCount(currentIds.length), currentIds));
      }
    }
    prevPaneIdsRef.current = currentIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = useCallback(
    (newTree: MosaicNode<string> | null) => {
      updateTree(newTree);
    },
    [updateTree],
  );

  const handleAddPane = useCallback(() => {
    addPane();
  }, [addPane]);

  const handleRemovePane = useCallback(
    (paneId: string) => {
      removePane(paneId);
    },
    [removePane],
  );

  const renderTile = useCallback(
    (id: string, path: MosaicPath) => {
      const pane = panes.find((p) => p.id === id);
      if (!pane) return <div />;

      return (
        <MosaicWindow<string>
          path={path}
          title={pane.cliCommand}
          toolbarControls={<></>}
          renderToolbar={null}
          draggable
        >
          <MosaicTile paneId={id}>
            <TerminalPane
              paneId={id}
              cliCommand={pane.cliCommand}
              cliArgs={pane.cliArgs}
              initialPrompt={pane.initialPrompt}
              onClose={() => handleRemovePane(id)}
              showCloseButton={panes.length > 1}
            />
          </MosaicTile>
        </MosaicWindow>
      );
    },
    [panes, handleRemovePane],
  );

  const paneIds = panes.map((p) => p.id);

  if (panes.length === 0) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex-1 flex items-center justify-center bg-bg-primary">
          <p className="text-sm text-text-muted">
            Click <span className="text-text-secondary font-medium">Sessions</span> to view active sessions, or{" "}
            <span className="text-text-secondary font-medium">Claude</span> /{" "}
            <span className="text-text-secondary font-medium">Codex</span> to start a new one
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <MosaicToolbar
        paneCount={panes.length}
        onAddPane={handleAddPane}
        paneIds={paneIds}
      />
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
