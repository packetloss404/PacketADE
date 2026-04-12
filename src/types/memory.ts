export interface FileMapEntry {
  path: string;
  summary: string;
  lastAnalyzed: number;
}

export interface SessionSummary {
  id: string;
  sessionTitle: string;
  summary: string;
  keyDecisions: string[];
  filesModified: string[];
  createdAt: number;
}

export interface LearnedPattern {
  id: string;
  pattern: string;
  category: "architecture" | "convention" | "preference" | "pitfall";
  confidence: number;
  sources: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemoryState {
  /** The project path this memory was scanned from. Used to scope context
   *  to the active project so a scan of project A doesn't leak into a
   *  Claude session opened in project B. */
  projectPath: string | null;
  fileMap: FileMapEntry[];
  sessionSummaries: SessionSummary[];
  patterns: LearnedPattern[];
  lastScanAt: number | null;
}
