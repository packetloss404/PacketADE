import { useCallback, useEffect, useState, useRef } from "react";
import { Mosaic, MosaicWindow } from "react-mosaic-component";
import { Minimize2 } from "lucide-react";
import type { MosaicNode, MosaicPath } from "@/types/mosaic";
import { WorkspacePane } from "./WorkspacePane";
import { ConversationTile } from "./ConversationTile";
import { FileTile } from "./FileTile";
import { isLocalWorkspace, type Workspace } from "@/types/workspace";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useReviewStore } from "@/stores/reviewStore";
import { isModalOpen } from "@/lib/modalStack";
import { isTerminalTarget } from "@/lib/keyboardTarget";
import {
  buildPresetTree,
  presetForCount,
  appendPane,
  removeFromTree,
  getLeafOrder,
  reconcileLayout,
  hasCollapsedSplit,
} from "@/lib/mosaicPresets";

interface WorkspaceMosaicContainerProps {
  workspace: Workspace;
  /** Permit initial PTY startup only for the visible, selected Workspace. */
  autoStartTerminals?: boolean;
  /**
   * Whether the Workspace surface itself is on screen. WorkspaceView stays
   * mounted under `display:none` while other views render, so without this the
   * zoom-exit listener would consume Escape pressed in Agents.
   */
  surfaceActive?: boolean;
}

/**
 * Mosaic tiling container for workspace multi-agent grids.
 * Each workspace gets its own ephemeral mosaic tree.
 */
export function WorkspaceMosaicContainer({
  workspace,
  autoStartTerminals = true,
  surfaceActive = true,
}: WorkspaceMosaicContainerProps) {
  const [tree, setTree] = useState<MosaicNode<string> | null>(null);
  const prevPaneKeyRef = useRef<string>("");
  const zoomedPaneId = useWorkspaceStore((s) => s.zoomedPaneId);
  const setZoomedPane = useWorkspaceStore((s) => s.setZoomedPane);
  const isActiveWorkspace = useWorkspaceStore((s) => s.activeWorkspaceId === workspace.id);
  const setWorkspaceLayout = useWorkspaceStore((s) => s.setWorkspaceLayout);

  // Read through a ref: the saved layout is consumed exactly once, when the
  // tree is first built. Depending on it directly would make the pane-sync
  // effect re-run every time we persist a change to it.
  const layoutRef = useRef(workspace.layout);
  layoutRef.current = workspace.layout;

  const workspaceId = workspace.id;
  const persist = useCallback(
    (next: MosaicNode<string> | null) => {
      setWorkspaceLayout(workspaceId, next);
    },
    [workspaceId, setWorkspaceLayout],
  );

  /**
   * Mirror of `tree`, kept so the pane-sync effect can read the current tree
   * without a functional `setTree` updater. The updater form would be the
   * obvious way to read it, but updaters must be PURE — React may invoke them
   * twice — and this effect also has to persist the result. Reading a ref and
   * calling `setTree` with a plain value keeps the write and the side effect
   * out of the updater.
   */
  const treeRef = useRef<MosaicNode<string> | null>(null);
  const applyTree = useCallback((next: MosaicNode<string> | null) => {
    treeRef.current = next;
    setTree(next);
  }, []);

  // A zoom left behind in a non-active workspace is deliberately NOT cleared.
  // `mosaic-zoom-active` is applied per container, gated on THIS workspace
  // owning the zoomed pane (see the `zoomedPane` lookup below), so a background
  // zoom cannot blank the workspace on screen — it simply waits, still zoomed,
  // for the user to come back. Clearing it here instead would race the review
  // auto-zoom in `ConversationTile`, whose effect is keyed on `reviewOpen` and
  // would never re-fire once cancelled, leaving a review rendered at raw tile
  // width — the one thing that tile says must never happen.

  // Escape exits zoom — the LOWEST-priority Escape consumer in the app, so
  // every layer that can own the keypress is checked first.
  //
  // Ordering is the whole point. This listener registers when zoom is SET,
  // which is before any dialog opened afterwards registers its own, and window
  // listeners fire in registration order. So `defaultPrevented` alone could
  // never have saved the dialog: zoom ran first, called `preventDefault`, and
  // `Modal` then bailed on exactly the flag zoom had just set. Zooming a pane
  // and opening any dialog meant Escape closed the ZOOM and left the dialog
  // open. The explicit checks below are what actually order the layers.
  useEffect(() => {
    if (!zoomedPaneId) return;
    // Only the visible workspace's container handles the key: otherwise every
    // mounted container registered a listener and they all fired at once, and
    // Escape pressed in Agents would silently un-zoom an off-screen pane.
    if (!isActiveWorkspace || !surfaceActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.isComposing) return;
      // An inner layer already handled this keypress.
      if (e.defaultPrevented) return;
      // Any open dialog outranks zoom.
      if (isModalOpen()) return;
      // A focused terminal owns every key, Escape included — leaving vim's
      // insert mode must not also throw away the zoom.
      if (isTerminalTarget(e)) return;
      // The review surface owns its own Escape and keeps its auto-zoom. This
      // must be SCOPED to a review of the pane actually zoomed here:
      // `reviewStore.open` is a global flag that nothing resets on a view
      // change, so an unscoped read left Escape permanently dead after opening
      // review in Agents and switching to Workspace — with the un-exitable
      // zoom and the on-screen "Press Esc" hint both still showing.
      const review = useReviewStore.getState();
      if (review.open) {
        const zoomed = workspace.panes.find((p) => p.id === zoomedPaneId);
        if (zoomed?.kind === "conversation" && zoomed.conversationId === review.conversationId) {
          return;
        }
      }
      e.preventDefault();
      setZoomedPane(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomedPaneId, isActiveWorkspace, surfaceActive, workspace.panes, setZoomedPane]);

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
      applyTree(null);
      // Deliberately does NOT clear the saved layout: emptying a workspace is
      // usually a step on the way to refilling it, and discarding the
      // arrangement here would throw it away for a round-trip through zero.
      return;
    }
    // No single-pane special case: a bare-leaf root would have to be wrapped
    // in a split when the second pane arrives, and wrapping changes the first
    // pane's depth — which remounts it and restarts its agent. `buildPresetTree`
    // returns a split even for one pane so growth is always a plain append.

    const currentTree = treeRef.current;

    // First build for this workspace: prefer the user's saved arrangement over
    // the preset. It is only a cache of a layout, never the truth about which
    // panes exist, so it is reconciled against the real pane list first —
    // leaves whose pane is gone are pruned, panes it never saw are appended.
    // `null` back means nothing usable survived; fall through to the preset.
    if (!currentTree || prevIds.length === 0) {
      const restored = reconcileLayout(layoutRef.current, nextIds);
      applyTree(restored ?? buildPresetTree(presetForCount(nextIds.length), nextIds));
      return;
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

    applyTree(updated);
    // Deliberately NOT persisted. Only a user gesture (`onRelease`) writes a
    // layout, for three reasons:
    //   - `reconcileLayout` already appends new panes and prunes closed ones on
    //     load, using the same `appendPane` this branch does, so the restored
    //     tree matches what was on screen anyway;
    //   - saving here would freeze the append-grown shape forever. Six panes
    //     added one at a time become six ~16% columns, which used to be
    //     ephemeral because the next launch rebuilt from `presetForCount`.
    //     Persisting it would have quietly retired that heal for workspaces the
    //     user never arranged;
    //   - `addPane`/`removePane` already commit the whole workspace list (Tauri
    //     IPC plus a full localStorage serialization). A second write here
    //     doubled that cost on every pane operation.
  }, [paneKey, applyTree]);

  // Local state only — `onChange` fires on every frame of a splitter drag
  // (react-mosaic throttles to 30Hz), and persisting there would mean a Tauri
  // IPC round-trip plus a full-workspace JSON.stringify 30 times a second.
  const handleChange = useCallback(
    (newTree: MosaicNode<string> | null) => {
      applyTree(newTree);
    },
    [applyTree],
  );

  // `onRelease` fires once per completed drag/resize gesture — the correct
  // write point, and why this needs no debounce of its own.
  //
  // It is NOT only fired on completion, though: `MosaicWindow`'s drag source
  // calls `mosaicActions.hide(path)` on drag START, and `hide` forwards only
  // `suppressOnChange`, so a release event also lands mid-drag with the dragged
  // tile collapsed to 0%. Persisting that would save an invisible pane — and
  // quitting mid-drag would make it permanent. Refuse any tree carrying a
  // collapsed split; the real drop fires again with sane geometry.
  const handleRelease = useCallback(
    (newTree: MosaicNode<string> | null) => {
      if (hasCollapsedSplit(newTree)) return;
      persist(newTree);
    },
    [persist],
  );

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
                workspaceId={workspace.id}
                projectPath={workspace.projectPath}
                remote={!isLocalWorkspace(workspace)}
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
          onRelease={handleRelease}
          className={zoomedPane ? "mosaic-zoom-active" : ""}
        />

        {zoomedPane && (
          <div className="bg-bg-secondary/90 absolute bottom-3 right-3 z-20 flex select-none items-center gap-1.5 rounded border border-bg-border px-2 py-1 text-meta text-text-muted">
            <Minimize2 size={10} />
            {/* Honest about the terminal case: a focused terminal owns Escape,
                so the tile's own zoom button is the way out of a zoomed shell. */}
            <span>Press Esc — or the tile's zoom button — to exit</span>
          </div>
        )}
      </div>
    </div>
  );
}
