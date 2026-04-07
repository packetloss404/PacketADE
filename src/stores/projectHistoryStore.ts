import { create } from "zustand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";

const STORAGE_KEY = "packetcode:project-history";

export interface ProjectHistoryEntry {
  path: string;
  lastOpened: number;
}

interface ProjectHistoryStore {
  projects: ProjectHistoryEntry[];
  recordOpen: (path: string) => void;
  removeProject: (path: string) => void;
}

function load(): ProjectHistoryEntry[] {
  return loadFromStorage<ProjectHistoryEntry[]>(STORAGE_KEY, []);
}

function persist(projects: ProjectHistoryEntry[]) {
  saveToStorage(STORAGE_KEY, projects);
}

export const useProjectHistoryStore = create<ProjectHistoryStore>((set) => ({
  projects: load(),

  recordOpen: (path) => {
    if (!path) return;
    set((s) => {
      const filtered = s.projects.filter((p) => p.path !== path);
      const projects = [{ path, lastOpened: Date.now() }, ...filtered];
      persist(projects);
      return { projects };
    });
  },

  removeProject: (path) => {
    set((s) => {
      const projects = s.projects.filter((p) => p.path !== path);
      persist(projects);
      return { projects };
    });
  },
}));
