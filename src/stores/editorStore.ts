import { create } from "zustand";

export interface OpenFile {
  id: string;
  path: string;
}

interface EditorStore {
  openFiles: OpenFile[];
  activeFileId: string | null;
  openFile: (path: string) => void;
  closeFile: (id: string) => void;
  setActiveFile: (id: string) => void;
}

let fileCounter = 0;

export const useEditorStore = create<EditorStore>((set, get) => ({
  openFiles: [],
  activeFileId: null,

  openFile: (path: string) => {
    const { openFiles } = get();
    // If already open, just activate it
    const existing = openFiles.find((f) => f.path === path);
    if (existing) {
      set({ activeFileId: existing.id });
      return;
    }
    const id = `editor-${++fileCounter}`;
    set({
      openFiles: [...openFiles, { id, path }],
      activeFileId: id,
    });
  },

  closeFile: (id: string) => {
    const { openFiles, activeFileId } = get();
    const filtered = openFiles.filter((f) => f.id !== id);
    let nextActive = activeFileId;
    if (activeFileId === id) {
      nextActive = filtered.length > 0 ? filtered[filtered.length - 1].id : null;
    }
    set({ openFiles: filtered, activeFileId: nextActive });
  },

  setActiveFile: (id: string) => {
    set({ activeFileId: id });
  },
}));
