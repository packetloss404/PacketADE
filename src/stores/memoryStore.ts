import { create } from "zustand";
import { scanCodebaseMemory, summarizeSession, extractPatterns } from "@/lib/tauri";
import type {
  MemoryState,
  FileMapEntry,
  SessionSummary,
  LearnedPattern,
} from "@/types/memory";
import { loadFromStorage, saveToStorage, parseJsonFromResponse } from "@/lib/storage";

const STORAGE_KEY = "packetcode:memory";
const DEFAULT_MEMORY: MemoryState = {
  projectPath: null,
  fileMap: [],
  sessionSummaries: [],
  patterns: [],
  lastScanAt: null,
};

function loadMemory(): MemoryState {
  return loadFromStorage(STORAGE_KEY, DEFAULT_MEMORY);
}

function saveMemory(memory: MemoryState) {
  saveToStorage(STORAGE_KEY, memory);
}

/** Normalize a project path so case / slash differences don't cause false mismatches. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

interface MemoryStore {
  memory: MemoryState;
  isScanning: boolean;
  scanError: string | null;

  scanCodebase: (projectPath: string) => Promise<void>;
  addSessionSummary: (
    projectPath: string,
    sessionTitle: string,
    sessionLog: string
  ) => Promise<void>;
  refreshPatterns: (projectPath: string) => Promise<void>;
  clearMemory: () => void;
  deletePattern: (id: string) => void;
  deleteSummary: (id: string) => void;
  /** Returns the memory context for a session if (and only if) the memory
   *  was scanned from the same project path. Pass an empty string to skip. */
  getContextForSession: (currentProjectPath: string) => string;
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  memory: loadMemory(),
  isScanning: false,
  scanError: null,

  scanCodebase: async (projectPath) => {
    set({ isScanning: true, scanError: null });
    try {
      const result = await scanCodebaseMemory(projectPath);
      const parsed = parseJsonFromResponse(result) as {
        path: string;
        summary: string;
      }[];
      const fileMap: FileMapEntry[] = parsed.map((e) => ({
        path: e.path,
        summary: e.summary,
        lastAnalyzed: Date.now(),
      }));
      const prev = get().memory;
      // If the user re-scans a different project, drop the stale data
      // for the previous one — memory is single-project today.
      const isSameProject =
        prev.projectPath && normalizePath(prev.projectPath) === normalizePath(projectPath);
      const memory: MemoryState = isSameProject
        ? { ...prev, fileMap, projectPath, lastScanAt: Date.now() }
        : {
            projectPath,
            fileMap,
            sessionSummaries: [],
            patterns: [],
            lastScanAt: Date.now(),
          };
      saveMemory(memory);
      set({ memory, isScanning: false });
    } catch (e) {
      set({ scanError: String(e), isScanning: false });
    }
  },

  addSessionSummary: async (projectPath, sessionTitle, sessionLog) => {
    set({ isScanning: true, scanError: null });
    try {
      const result = await summarizeSession(projectPath, sessionLog);
      const parsed = parseJsonFromResponse(result) as {
        summary: string;
        keyDecisions: string[];
        filesModified: string[];
      };
      const summary: SessionSummary = {
        id: `session-${Date.now()}`,
        sessionTitle,
        summary: parsed.summary,
        keyDecisions: parsed.keyDecisions || [],
        filesModified: parsed.filesModified || [],
        createdAt: Date.now(),
      };
      const memory = {
        ...get().memory,
        sessionSummaries: [...get().memory.sessionSummaries, summary],
      };
      saveMemory(memory);
      set({ memory, isScanning: false });
    } catch (e) {
      set({ scanError: String(e), isScanning: false });
    }
  },

  refreshPatterns: async (projectPath) => {
    const { sessionSummaries } = get().memory;
    if (sessionSummaries.length === 0) return;
    set({ isScanning: true, scanError: null });
    try {
      const summariesText = sessionSummaries
        .map((s) => `[${s.sessionTitle}]: ${s.summary}`)
        .join("\n\n");
      const result = await extractPatterns(projectPath, summariesText);
      const parsed = parseJsonFromResponse(result) as {
        pattern: string;
        category: string;
        confidence: number;
      }[];
      const patterns: LearnedPattern[] = parsed.map((p, i) => ({
        id: `pattern-${Date.now()}-${i}`,
        pattern: p.pattern,
        category: p.category as LearnedPattern["category"],
        confidence: p.confidence,
        sources: sessionSummaries.map((s) => s.id),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
      const memory = { ...get().memory, patterns };
      saveMemory(memory);
      set({ memory, isScanning: false });
    } catch (e) {
      set({ scanError: String(e), isScanning: false });
    }
  },

  clearMemory: () => {
    const memory: MemoryState = {
      projectPath: null,
      fileMap: [],
      sessionSummaries: [],
      patterns: [],
      lastScanAt: null,
    };
    saveMemory(memory);
    set({ memory });
  },

  deletePattern: (id) => {
    const memory = {
      ...get().memory,
      patterns: get().memory.patterns.filter((p) => p.id !== id),
    };
    saveMemory(memory);
    set({ memory });
  },

  deleteSummary: (id) => {
    const memory = {
      ...get().memory,
      sessionSummaries: get().memory.sessionSummaries.filter(
        (s) => s.id !== id
      ),
    };
    saveMemory(memory);
    set({ memory });
  },

  getContextForSession: (currentProjectPath: string) => {
    const memory = get().memory;

    // No memory yet, or no current project to compare against → no context.
    if (!memory.projectPath || !currentProjectPath) return "";

    // Memory was scanned from a different project — refuse to leak it.
    if (normalizePath(memory.projectPath) !== normalizePath(currentProjectPath)) {
      return "";
    }

    const { patterns, fileMap } = memory;
    const lines: string[] = [];

    if (patterns.length > 0) {
      lines.push("## Codebase Patterns");
      patterns
        .filter((p) => p.confidence >= 0.5)
        .forEach((p) => {
          lines.push(`- [${p.category}] ${p.pattern}`);
        });
      lines.push("");
    }

    if (fileMap.length > 0) {
      lines.push("## Key Files");
      fileMap.slice(0, 20).forEach((f) => {
        lines.push(`- ${f.path}: ${f.summary}`);
      });
      lines.push("");
    }

    return lines.join("\n");
  },
}));
