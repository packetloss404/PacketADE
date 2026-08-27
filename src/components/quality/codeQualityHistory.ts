import type { CodeQualityReport } from "@/lib/tauri";

/**
 * Persistent history of recent Code Quality runs, keyed by the project path
 * so each workspace gets its own ring buffer.
 *
 * Stored under `packetbench:quality:history` so it survives app restarts and
 * doesn't bloat the main Zustand bundle. A full Zustand store is overkill
 * for a tiny localStorage ring buffer.
 *
 * Each entry is a {@link CodeQualityHistoryEntry} carrying enough to render
 * the trend chip (score + headline counts) without re-running the analyzer.
 */

export interface CodeQualityHistoryEntry {
  /** Absolute project path (Windows or POSIX). */
  projectPath: string;
  /** Epoch milliseconds. */
  ranAt: number;
  /** 0-100 weighted score we display in the donut. */
  totalScore: number;
  /** Headline counts captured at run time. */
  totalFiles: number;
  totalCodeLines: number;
  testFiles: number;
  /** Full report snapshot. Bounded by `MAX_ENTRIES`. */
  report: CodeQualityReport;
}

const STORAGE_KEY = "packetbench:quality:history";
const MAX_ENTRIES_PER_PROJECT = 5;

interface HistoryShape {
  /** `projectPath` (normalised lowercase) → recent entries (newest first). */
  byProject: Record<string, CodeQualityHistoryEntry[]>;
}

function normalisePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function readStore(): HistoryShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { byProject: {} };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.byProject) {
      return parsed as HistoryShape;
    }
  } catch {
    // Corrupt entry — start fresh. Don't throw out of a read.
  }
  return { byProject: {} };
}

function writeStore(state: HistoryShape) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage unavailable. Trimming would help but the
    // ring buffer is already small; swallow.
  }
}

export function loadQualityHistory(projectPath: string): CodeQualityHistoryEntry[] {
  if (!projectPath) return [];
  const store = readStore();
  return store.byProject[normalisePath(projectPath)] ?? [];
}

export function appendQualityHistory(entry: CodeQualityHistoryEntry): CodeQualityHistoryEntry[] {
  if (!entry.projectPath) return [];
  const store = readStore();
  const key = normalisePath(entry.projectPath);
  const existing = store.byProject[key] ?? [];
  const next = [entry, ...existing].slice(0, MAX_ENTRIES_PER_PROJECT);
  store.byProject[key] = next;
  writeStore(store);
  return next;
}

export function clearQualityHistory(projectPath: string) {
  if (!projectPath) return;
  const store = readStore();
  delete store.byProject[normalisePath(projectPath)];
  writeStore(store);
}

export function formatScoreDelta(current: number, prior: number | undefined): {
  text: string;
  color: string;
} {
  if (prior === undefined) return { text: "—", color: "#6e7681" };
  const diff = current - prior;
  if (diff === 0) return { text: "±0", color: "#6e7681" };
  if (diff > 0) return { text: `+${diff}`, color: "#56d364" };
  return { text: `${diff}`, color: "#f85149" };
}
