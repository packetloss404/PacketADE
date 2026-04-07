import { create } from "zustand";
import type { StatusLineData, CodexStatusLineData } from "@/types/statusline";

export interface StatusLineEntryBase {
  cwd: string;
  timestamp: number;
}

const STALE_ENTRY_SECONDS = 300;

function normalizeTimestampSeconds(timestamp: number): number {
  // Defensive guard in case a producer ever switches to milliseconds.
  return timestamp > 10_000_000_000
    ? Math.floor(timestamp / 1000)
    : timestamp;
}

export function normalizeStatusLineCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").toLowerCase();
}

export function mergeStatusLineEntries<T extends StatusLineEntryBase>(
  current: Record<string, T>,
  entries: T[],
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Record<string, T> {
  const next = { ...current };

  for (const entry of entries) {
    const key = normalizeStatusLineCwd(entry.cwd);
    const existing = next[key];
    if (!existing || entry.timestamp >= existing.timestamp) {
      next[key] = entry;
    }
  }

  for (const [key, entry] of Object.entries(next)) {
    if (nowSeconds - normalizeTimestampSeconds(entry.timestamp) > STALE_ENTRY_SECONDS) {
      delete next[key];
    }
  }

  return next;
}

interface StatusLineStoreShape<T extends StatusLineEntryBase> {
  byCwd: Record<string, T>;
  update: (entries: T[]) => void;
}

function createStatusLineStore<T extends StatusLineEntryBase>() {
  return create<StatusLineStoreShape<T>>((set) => ({
    byCwd: {},
    update: (entries) =>
      set((state) => ({ byCwd: mergeStatusLineEntries(state.byCwd, entries) })),
  }));
}

function createForCwdSelector<T extends StatusLineEntryBase>(
  useStore: ReturnType<typeof createStatusLineStore<T>>
) {
  return function useForCwd(cwd: string | undefined): T | null {
    return useStore((state) => {
      if (!cwd) return null;
      const key = normalizeStatusLineCwd(cwd);
      return state.byCwd[key] ?? null;
    });
  };
}

export const useStatusLineStore = createStatusLineStore<StatusLineData>();
export const useStatusLineForCwd = createForCwdSelector(useStatusLineStore);

export const useCodexStatusLineStore = createStatusLineStore<CodexStatusLineData>();
export const useCodexStatusLineForCwd = createForCwdSelector(useCodexStatusLineStore);
