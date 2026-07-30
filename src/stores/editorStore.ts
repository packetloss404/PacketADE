/**
 * D5 — the reconnected lightweight editor (audit finding P1-7).
 *
 * The buffer used to live inside `EditorPane`'s local state, so switching the
 * file tab, the dock panel, or the Workspace silently threw away unsaved work.
 * The buffer now lives here: switching anything is lossless, and the ONLY
 * discarding action left (closing a file) is guarded by an explicit confirm in
 * `EditorDockPanel`.
 */
import { create } from "zustand";

export type EditorViewMode = "raw" | "preview";

export interface OpenFile {
  id: string;
  /** Absolute path on the local filesystem. */
  path: string;
  /** Project root the Tauri FS commands scope this read/write to. */
  workspace: string;
  /** `null` until the first read resolves. */
  content: string | null;
  /** Last known on-disk content. Dirty ⇔ `content !== savedContent`. */
  savedContent: string | null;
  /** Markdown files open rendered; everything else opens raw (D5 amendment). */
  view: EditorViewMode;
  loading: boolean;
  error: string | null;
}

interface EditorStore {
  openFiles: OpenFile[];
  activeFileId: string | null;
  /** Opens (or re-activates) `path`. Returns the buffer id. */
  openFile: (path: string, workspace?: string) => string;
  closeFile: (id: string) => void;
  closeAll: () => void;
  setActiveFile: (id: string) => void;
  beginLoad: (id: string) => void;
  loadSucceeded: (id: string, content: string) => void;
  loadFailed: (id: string, error: string) => void;
  setContent: (id: string, content: string) => void;
  markSaved: (id: string, content: string) => void;
  setView: (id: string, view: EditorViewMode) => void;
}

let fileCounter = 0;

/** Markdown buffers get the rendered viewer + raw/preview toggle. */
export function isMarkdownPath(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

/** A buffer holds unsaved edits. */
export function isFileDirty(file: OpenFile | null | undefined): boolean {
  if (!file) return false;
  if (file.content === null || file.savedContent === null) return false;
  return file.content !== file.savedContent;
}

function patch(
  files: OpenFile[],
  id: string,
  updater: (file: OpenFile) => OpenFile,
): OpenFile[] {
  return files.map((f) => (f.id === id ? updater(f) : f));
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  openFiles: [],
  activeFileId: null,

  openFile: (path: string, workspace = "") => {
    const { openFiles } = get();
    const existing = openFiles.find((f) => f.path === path);
    if (existing) {
      set({ activeFileId: existing.id });
      return existing.id;
    }
    const id = `editor-${++fileCounter}`;
    const file: OpenFile = {
      id,
      path,
      workspace,
      content: null,
      savedContent: null,
      view: isMarkdownPath(path) ? "preview" : "raw",
      loading: false,
      error: null,
    };
    set({ openFiles: [...openFiles, file], activeFileId: id });
    return id;
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

  closeAll: () => set({ openFiles: [], activeFileId: null }),

  setActiveFile: (id: string) => set({ activeFileId: id }),

  beginLoad: (id) =>
    set((s) => ({
      openFiles: patch(s.openFiles, id, (f) => ({ ...f, loading: true, error: null })),
    })),

  loadSucceeded: (id, content) =>
    set((s) => ({
      openFiles: patch(s.openFiles, id, (f) => ({
        ...f,
        loading: false,
        error: null,
        content,
        savedContent: content,
      })),
    })),

  loadFailed: (id, error) =>
    set((s) => ({
      openFiles: patch(s.openFiles, id, (f) => ({ ...f, loading: false, error })),
    })),

  setContent: (id, content) =>
    set((s) => ({
      openFiles: patch(s.openFiles, id, (f) => ({ ...f, content })),
    })),

  markSaved: (id, content) =>
    set((s) => ({
      openFiles: patch(s.openFiles, id, (f) => ({
        ...f,
        content,
        savedContent: content,
        error: null,
      })),
    })),

  setView: (id, view) =>
    set((s) => ({
      openFiles: patch(s.openFiles, id, (f) => ({ ...f, view })),
    })),
}));
