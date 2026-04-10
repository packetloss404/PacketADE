import { create } from "zustand";
import type { MosaicNode, MosaicLayoutPreset } from "@/types/mosaic";
import {
  buildPresetTree,
  getLeafOrder,
  addToTree,
  removeFromTree,
} from "@/lib/mosaicPresets";

const STORAGE_KEY = "packetcode:mosaic-layout";

interface MosaicStore {
  tree: MosaicNode<string> | null;
  minimizedPanes: Set<string>;

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
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedPersist(tree: MosaicNode<string> | null) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      if (tree) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tree));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // localStorage full or unavailable
    }
  }, 500);
}

export const useMosaicStore = create<MosaicStore>((set, get) => ({
  tree: null,
  minimizedPanes: new Set(),

  setTree: (tree) => {
    set({ tree });
    debouncedPersist(tree);
  },

  updateTree: (tree) => {
    set({ tree });
    debouncedPersist(tree);
  },

  splitPane: (existingId, newId, direction = "row") => {
    const { tree } = get();
    if (!tree) {
      set({ tree: newId });
      return;
    }
    const newTree = addToTree(tree, existingId, newId, direction);
    set({ tree: newTree });
    debouncedPersist(newTree);
  },

  removeNode: (paneId) => {
    const { tree, minimizedPanes } = get();
    if (!tree) return;
    const newTree = removeFromTree(tree, paneId);
    const newMinimized = new Set(minimizedPanes);
    newMinimized.delete(paneId);
    set({ tree: newTree, minimizedPanes: newMinimized });
    debouncedPersist(newTree);
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
    debouncedPersist(tree);
  },

  getLeafOrder: () => getLeafOrder(get().tree),

  persistLayout: () => {
    const { tree } = get();
    debouncedPersist(tree);
  },

  restoreLayout: (currentPaneIds) => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
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
}));
