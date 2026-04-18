import { create } from "zustand";
import { isSplitNode } from "react-mosaic-component";
import type { MosaicNode } from "@/types/mosaic";
import { loadFromStorage, saveToStorage } from "@/lib/storage";

/**
 * Per-conversation mosaic layout for AgentChatPane.
 *
 * Lets a single conversation tile its own panes (chat | diff | terminal | file)
 * Claude-Code-Desktop style. The default layout for any conversation is just
 * the bare "chat" leaf — adding a pane through `addPane` widens the tree, and
 * the `AgentMosaicShell` component only mounts a `<Mosaic>` once the layout
 * has more than just chat (so the no-split flow stays a plain flexbox).
 *
 * Tree shape mirrors react-mosaic-component v7's n-ary form (`{ type: "split",
 * direction, children: [...] }` with leaves as plain strings) — same shape
 * the workspace mosaic uses (see `src/lib/mosaicPresets.ts`).
 */

export type AgentPaneId = "chat" | "diff" | "terminal" | "file";

const STORAGE_KEY = "packetade:agent-mosaic-v1";

interface AgentMosaicState {
  /** Per-conversation mosaic tree. `null` means "default — single chat leaf". */
  layouts: Record<string, MosaicNode<AgentPaneId> | null>;

  /** Returns the saved layout, or `null` (interpreted as the implicit "chat" leaf). */
  getLayout: (convId: string) => MosaicNode<AgentPaneId> | null;
  /** Replace the layout for a conversation (mosaic onChange handler). */
  setLayout: (convId: string, node: MosaicNode<AgentPaneId> | null) => void;
  /**
   * Add a pane to the layout — splits the existing tree to the right by
   * default. No-op if the pane is already present (panes are unique per conv).
   */
  addPane: (convId: string, paneId: AgentPaneId) => void;
  /**
   * Remove a pane. If only "chat" remains afterwards the layout collapses
   * back to the implicit single-leaf default (entry deleted from the map).
   */
  removePane: (convId: string, paneId: AgentPaneId) => void;
}

/* ----------------------------- tree helpers ----------------------------- */

function collectLeaves(
  node: MosaicNode<AgentPaneId> | null,
): AgentPaneId[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  if (isSplitNode(node)) {
    return node.children.flatMap((c) => collectLeaves(c));
  }
  // TabsNode — flatten tabs.
  if ("tabs" in node) return node.tabs;
  return [];
}

/** Append `paneId` as a new column on the right of the existing tree. */
function appendLeaf(
  node: MosaicNode<AgentPaneId> | null,
  paneId: AgentPaneId,
): MosaicNode<AgentPaneId> {
  if (node == null) return paneId;
  // Wrap the current root with a row-split alongside the new leaf.
  return {
    type: "split",
    direction: "row",
    children: [node, paneId],
    splitPercentages: [65, 35],
  };
}

/** Return tree with `paneId` removed (collapsing single-child splits). Null if empty. */
function removeLeaf(
  node: MosaicNode<AgentPaneId> | null,
  paneId: AgentPaneId,
): MosaicNode<AgentPaneId> | null {
  if (node == null) return null;
  if (typeof node === "string") return node === paneId ? null : node;
  if (isSplitNode(node)) {
    const next = node.children
      .map((c) => removeLeaf(c, paneId))
      .filter((c): c is MosaicNode<AgentPaneId> => c !== null);
    if (next.length === 0) return null;
    if (next.length === 1) return next[0];
    return { ...node, children: next };
  }
  if ("tabs" in node) {
    const tabs = node.tabs.filter((t) => t !== paneId);
    if (tabs.length === 0) return null;
    if (tabs.length === 1) return tabs[0];
    return {
      ...node,
      tabs,
      activeTabIndex: Math.min(node.activeTabIndex, tabs.length - 1),
    };
  }
  return node;
}

/* -------------------------------- store -------------------------------- */

function persist(layouts: Record<string, MosaicNode<AgentPaneId> | null>) {
  saveToStorage(STORAGE_KEY, layouts);
}

export const useAgentMosaicStore = create<AgentMosaicState>((set, get) => ({
  layouts: loadFromStorage<Record<string, MosaicNode<AgentPaneId> | null>>(
    STORAGE_KEY,
    {},
  ),

  getLayout: (convId) => {
    const layout = get().layouts[convId];
    return layout ?? null;
  },

  setLayout: (convId, node) => {
    set((state) => {
      const next = { ...state.layouts, [convId]: node };
      persist(next);
      return { layouts: next };
    });
  },

  addPane: (convId, paneId) => {
    const current: MosaicNode<AgentPaneId> = get().layouts[convId] ?? "chat";
    const leaves = collectLeaves(current);
    if (leaves.includes(paneId)) return;
    const next = appendLeaf(current, paneId);
    get().setLayout(convId, next);
  },

  removePane: (convId, paneId) => {
    const current = get().layouts[convId];
    if (current == null) return;
    const next = removeLeaf(current, paneId);
    // Collapse to the implicit default when only "chat" remains.
    if (next === "chat" || next == null) {
      set((state) => {
        const layouts = { ...state.layouts };
        delete layouts[convId];
        persist(layouts);
        return { layouts };
      });
      return;
    }
    get().setLayout(convId, next);
  },
}));
