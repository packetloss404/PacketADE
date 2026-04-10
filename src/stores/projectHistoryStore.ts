import { create } from "zustand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";

const STORAGE_KEY = "packetcode:project-history";
const FOLDER_KEY = "packetcode:projects-folder";

export interface ProjectHistoryEntry {
  path: string;
  lastOpened: number;
}

interface ProjectHistoryStore {
  projects: ProjectHistoryEntry[];
  projectsFolder: string | null;
  scannedProjects: string[];

  recordOpen: (path: string) => void;
  removeProject: (path: string) => void;
  setProjectsFolder: (folder: string | null) => void;
  setScannedProjects: (paths: string[]) => void;
  scanProjectsFolder: () => Promise<void>;
}

function load(): ProjectHistoryEntry[] {
  return loadFromStorage<ProjectHistoryEntry[]>(STORAGE_KEY, []);
}

function persist(projects: ProjectHistoryEntry[]) {
  saveToStorage(STORAGE_KEY, projects);
}

function loadFolder(): string | null {
  return loadFromStorage<string | null>(FOLDER_KEY, null);
}

export const useProjectHistoryStore = create<ProjectHistoryStore>((set, get) => ({
  projects: load(),
  projectsFolder: loadFolder(),
  scannedProjects: [],

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

  setProjectsFolder: (folder) => {
    saveToStorage(FOLDER_KEY, folder);
    set({ projectsFolder: folder });
    if (folder) {
      get().scanProjectsFolder();
    } else {
      set({ scannedProjects: [] });
    }
  },

  setScannedProjects: (paths) => set({ scannedProjects: paths }),

  scanProjectsFolder: async () => {
    const folder = get().projectsFolder;
    if (!folder) return;
    try {
      const { listSubdirectories } = await import("@/lib/tauri");
      const dirs = await listSubdirectories(folder);
      set({ scannedProjects: dirs });
    } catch {
      set({ scannedProjects: [] });
    }
  },
}));
