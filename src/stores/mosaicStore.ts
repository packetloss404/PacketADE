import { create } from "zustand";
import type { MosaicNode, MosaicLayoutPreset } from "@/types/mosaic";
import {
  buildPresetTree,
  getLeafOrder,
  addToTree,
  removeFromTree,
} from "@/lib/mosaicPresets";

const STORAGE_PREFIX = "packetade:mosaic-layout";

interface MosaicStore {
  tree: MosaicNode<string> | null;
  minimizedPanes: Set<string>;
  /** Current storage scope — workspace ID or "session" for non-workspace panes */
  activeContextKey: string | null;

  setTree: (tree: MosaicNode<string> | null) => void;
  updateTree: (tree: MosaicNode<string> | null) => void;
  splitPane: (
    existingId: string,
    newId: string,
    direction?: "row" | "column",
  ) => void;
  removeNode: (paneId: string) => void;
  toggleMinimize: (paneId: string) => void;
  isMinimized: (paneId: string) => boolean;
  applyPreset: (preset: MosaicLayoutPreset, paneIds: string[]) => void;
  getLeafOrder: () => string[];
  persistLayout: () => void;
  restoreLayout: (currentPaneIds: string[]) => boolean;
  /** Switch context — saves current layout, loads the new context's layout */
  setContext: (key: string) => void;
}

function storageKey(contextKey: string | null): string {
  return contextKey ? `${STORAGE_PREFIX}:${contextKey}` : STORAGE_PREFIX;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedPersist(tree: MosaicNode<string> | null, contextKey: string | null) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const key = storageKey(contextKey);
    try {
      if (tree) {
        localStorage.setItem(key, JSON.stringify(tree));
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // localStorage full or unavailable
    }
  }, 500);
}

export const useMosaicStore = create<MosaicStore>((set, get) => ({
  tree: null,
  minimizedPanes: new Set(),
  activeContextKey: null,

  setTree: (tree) => {
    set({ tree });
    debouncedPersist(tree, get().activeContextKey);
  },

  updateTree: (tree) => {
    set({ tree });
    debouncedPersist(tree, get().activeContextKey);
  },

  splitPane: (existingId, newId, direction = "row") => {
    const { tree, activeContextKey } = get();
    if (!tree) {
      set({ tree: newId });
      return;
    }
    const newTree = addToTree(tree, existingId, newId, direction);
    set({ tree: newTree });
    debouncedPersist(newTree, activeContextKey);
  },

  removeNode: (paneId) => {
    const { tree, minimizedPanes, activeContextKey } = get();
    if (!tree) return;
    const newTree = removeFromTree(tree, paneId);
    const newMinimized = new Set(minimizedPanes);
    newMinimized.delete(paneId);
    set({ tree: newTree, minimizedPanes: newMinimized });
    debouncedPersist(newTree, activeContextKey);
  },

  toggleMinimize: (paneId) => {
    const { minimizedPanes } = get();
    const next = new Set(minimizedPanes);
    if (next.has(paneId)) {
      next.delete(paneId);
    } else {
      next.add(paneId);
    }
    set({ minimizedPanes: next });
  },

  isMinimized: (paneId) => get().minimizedPanes.has(paneId),

  applyPreset: (preset, paneIds) => {
    const tree = buildPresetTree(preset, paneIds);
    set({ tree, minimizedPanes: new Set() });
    debouncedPersist(tree, get().activeContextKey);
  },

  getLeafOrder: () => getLeafOrder(get().tree),

  persistLayout: () => {
    const { tree, activeContextKey } = get();
    debouncedPersist(tree, activeContextKey);
  },

  restoreLayout: (currentPaneIds) => {
    const { activeContextKey } = get();
    try {
      const saved = localStorage.getItem(storageKey(activeContextKey));
      if (!saved) return false;
      const tree = JSON.parse(saved) as MosaicNode<string>;
      const leaves = getLeafOrder(tree);
      const currentSet = new Set(currentPaneIds);
      // Only restore if all leaves exist in current panes
      if (leaves.every((id) => currentSet.has(id))) {
        set({ tree });
        return true;
      }
    } catch {
      // corrupt data
    }
    return false;
  },

  setContext: (key) => {
    // Save current layout before switching
    const { tree, activeContextKey } = get();
    if (activeContextKey && tree) {
      const currentKey = storageKey(activeContextKey);
      try {
        localStorage.setItem(currentKey, JSON.stringify(tree));
      } catch {
        // ignore
      }
    }

    // Load the new context's layout
    const newKey = storageKey(key);
    let newTree: MosaicNode<string> | null = null;
    try {
      const saved = localStorage.getItem(newKey);
      if (saved) {
        newTree = JSON.parse(saved) as MosaicNode<string>;
      }
    } catch {
      // corrupt data
    }

    set({
      activeContextKey: key,
      tree: newTree,
      minimizedPanes: new Set(),
    });
  },
}));
