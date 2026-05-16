/**
 * Per-CLI manual-path overrides for the v0.8.7 Tools → CLI Agents grid.
 *
 * When a CLI binary isn't on PATH (or the user wants to pin a specific
 * non-PATH copy), the Browse-for-binary affordance writes the chosen file
 * path here and the bulk-rescan loop forwards it to the detector as the
 * `manualPath` field on each `DetectCatalogItem`. Persisted to
 * localStorage so the override survives restarts (the detector itself is
 * stateless and re-resolves the binary every scan).
 */
import { create } from "zustand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";

const STORAGE_KEY = "packetade:cli-overrides";

export interface CliOverrideEntry {
  manualPath: string;
}

interface CliOverrideStore {
  /** Per-CLI overrides keyed by catalog id. */
  overrides: Record<string, CliOverrideEntry>;
  setManualPath: (cliId: string, path: string) => void;
  clearManualPath: (cliId: string) => void;
}

function load(): Record<string, CliOverrideEntry> {
  const raw = loadFromStorage<Record<string, CliOverrideEntry>>(STORAGE_KEY, {});
  // Defensive: localStorage may contain a stale shape from an aborted upgrade.
  // Reduce to the documented `{ manualPath: string }` to avoid leaking
  // malformed entries into the detector.
  const out: Record<string, CliOverrideEntry> = {};
  for (const [id, entry] of Object.entries(raw ?? {})) {
    const p = (entry as { manualPath?: unknown })?.manualPath;
    if (typeof p === "string" && p.trim().length > 0) {
      out[id] = { manualPath: p };
    }
  }
  return out;
}

function persist(overrides: Record<string, CliOverrideEntry>) {
  saveToStorage(STORAGE_KEY, overrides);
}

export const useCliOverrideStore = create<CliOverrideStore>((set) => ({
  overrides: load(),

  setManualPath: (cliId, path) => {
    const trimmed = path.trim();
    if (!cliId || !trimmed) return;
    set((s) => {
      const overrides = { ...s.overrides, [cliId]: { manualPath: trimmed } };
      persist(overrides);
      return { overrides };
    });
  },

  clearManualPath: (cliId) => {
    set((s) => {
      if (!(cliId in s.overrides)) return s;
      const overrides = { ...s.overrides };
      delete overrides[cliId];
      persist(overrides);
      return { overrides };
    });
  },
}));
