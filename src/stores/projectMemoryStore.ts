import { create } from "zustand";
import {
  archiveProjectMemory,
  createProjectMemory,
  listProjectMemory,
  updateProjectMemory,
  watchProjectMemory,
} from "@/lib/tauri";
import type {
  CreateProjectMemoryInput,
  ProjectMemoryNote,
  ProjectMemorySnapshot,
  UpdateProjectMemoryInput,
} from "@/types/project-memory";

const EMPTY_SNAPSHOT: ProjectMemorySnapshot = {
  schemaVersion: 1,
  directory: ".agents/memory",
  notes: [],
  warnings: [],
  revision: "",
};

interface ProjectMemoryStore {
  projectPath: string | null;
  snapshot: ProjectMemorySnapshot;
  loading: boolean;
  error: string | null;
  changedExternally: boolean;
  ownWriteUntil: number;
  load: (projectPath: string, external?: boolean) => Promise<void>;
  createNote: (
    input: CreateProjectMemoryInput,
  ) => Promise<ProjectMemoryNote | null>;
  updateNote: (
    input: UpdateProjectMemoryInput,
  ) => Promise<ProjectMemoryNote | null>;
  archiveNote: (
    id: string,
    expectedRevision: string,
  ) => Promise<ProjectMemoryNote | null>;
  clearError: () => void;
  acknowledgeExternalChange: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useProjectMemoryStore = create<ProjectMemoryStore>((set, get) => ({
  projectPath: null,
  snapshot: EMPTY_SNAPSHOT,
  loading: false,
  error: null,
  changedExternally: false,
  ownWriteUntil: 0,

  load: async (projectPath, external = false) => {
    const effectiveExternal =
      external && Date.now() > get().ownWriteUntil;
    set({
      projectPath,
      loading: true,
      error: null,
      changedExternally: effectiveExternal || get().changedExternally,
    });
    try {
      await watchProjectMemory(projectPath);
      const snapshot = await listProjectMemory(projectPath);
      if (get().projectPath !== projectPath) return;
      set({ snapshot, loading: false });
    } catch (error) {
      if (get().projectPath !== projectPath) return;
      set({ loading: false, error: errorMessage(error) });
    }
  },

  createNote: async (input) => {
    const projectPath = get().projectPath;
    if (!projectPath) return null;
    try {
      set({ ownWriteUntil: Date.now() + 1_500 });
      const note = await createProjectMemory(projectPath, input);
      await get().load(projectPath);
      return note;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  updateNote: async (input) => {
    const projectPath = get().projectPath;
    if (!projectPath) return null;
    try {
      set({ ownWriteUntil: Date.now() + 1_500 });
      const note = await updateProjectMemory(projectPath, input);
      await get().load(projectPath);
      set({ changedExternally: false });
      return note;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  archiveNote: async (id, expectedRevision) => {
    const projectPath = get().projectPath;
    if (!projectPath) return null;
    try {
      set({ ownWriteUntil: Date.now() + 1_500 });
      const note = await archiveProjectMemory(projectPath, id, expectedRevision);
      await get().load(projectPath);
      return note;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  clearError: () => set({ error: null }),
  acknowledgeExternalChange: () => set({ changedExternally: false }),
}));
