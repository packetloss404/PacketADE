/**
 * Shared sidebar preferences.
 *
 * Kept deliberately separate from `agentTaskStore` (which owns the
 * conversations themselves) so the two lanes don't collide — this store
 * only holds lightweight, UI-local metadata:
 *   - per-conversation / per-row pin flags (keyed by row id)
 *   - project group display labels (keyed by projectPath)
 *
 * Tile program (P4-S2): `projectLabels` moved here from `agentTaskStore` so the
 * FleetSidebar and the legacy AgentSidebar share ONE source of truth for
 * project-group renames (single-truth; both sidebars stay in sync). The
 * localStorage key is unchanged (`packetade:project-labels`, with the same
 * one-shot legacy migration), so existing user renames carry over untouched.
 *
 * This store is explicitly exempt from the P1 store-isolation import ban — it is
 * UI-prefs, not an engine store, and both sidebars read it directly.
 */
import { create } from "zustand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";
import { storageKey, LEGACY_STORAGE_PREFIX } from "@/lib/brand";

const STORAGE_KEY = "packetade:agent-sidebar-prefs";
const PROJECT_LABELS_STORAGE_KEY = storageKey("project-labels");
const LEGACY_PROJECT_LABELS_STORAGE_KEY = `${LEGACY_STORAGE_PREFIX}project-labels`;

export interface ConversationPrefs {
  pinned?: boolean;
}

interface PersistedState {
  /** rowId (conversationId or workspaceId) -> { pinned? } */
  prefs: Record<string, ConversationPrefs>;
}

interface AgentSidebarPrefsStore extends PersistedState {
  /** projectPath -> custom display label for the project group header. */
  projectLabels: Record<string, string>;
  togglePinned: (rowId: string) => void;
  setProjectLabel: (projectPath: string, label: string) => void;
}

function load(): PersistedState {
  const raw = loadFromStorage<Partial<PersistedState>>(STORAGE_KEY, {});
  // Defensive: reduce persisted prefs to the documented shape so a stale /
  // malformed entry (e.g. dropped `tags`/`sortMode` fields) can't leak into
  // the sidebar render. Those stale fields are silently dropped here and
  // will not be written back on the next persist().
  const prefs: Record<string, ConversationPrefs> = {};
  for (const [id, entry] of Object.entries(raw?.prefs ?? {})) {
    const e = entry as { pinned?: unknown };
    if (e?.pinned === true) prefs[id] = { pinned: true };
  }
  return { prefs };
}

function persist(state: PersistedState) {
  saveToStorage(STORAGE_KEY, { prefs: state.prefs });
}

/**
 * Load project labels from the branded key, migrating the legacy
 * `packetcode:project-labels` blob one-shot on first boot. Mirrors the logic
 * that previously lived in `agentTaskStore.loadProjectLabels`.
 */
function loadProjectLabels(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const currentRaw = localStorage.getItem(PROJECT_LABELS_STORAGE_KEY);
    if (currentRaw) return JSON.parse(currentRaw) as Record<string, string>;

    const legacyRaw = localStorage.getItem(LEGACY_PROJECT_LABELS_STORAGE_KEY);
    if (!legacyRaw) return {};

    const migrated = JSON.parse(legacyRaw) as Record<string, string>;
    localStorage.setItem(PROJECT_LABELS_STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return {};
  }
}

const initial = load();

export const useAgentSidebarPrefsStore = create<AgentSidebarPrefsStore>((set) => ({
  prefs: initial.prefs,
  projectLabels: loadProjectLabels(),

  togglePinned: (rowId) => {
    if (!rowId) return;
    set((s) => {
      const current = s.prefs[rowId] ?? {};
      const nextPinned = !current.pinned;
      const prefs = { ...s.prefs };
      if (nextPinned) prefs[rowId] = { pinned: true };
      else delete prefs[rowId];
      persist({ prefs });
      return { prefs };
    });
  },

  setProjectLabel: (projectPath, label) => {
    set((s) => {
      const next = { ...s.projectLabels };
      const trimmed = label.trim();
      if (trimmed) next[projectPath] = trimmed;
      else delete next[projectPath];
      try {
        localStorage.setItem(PROJECT_LABELS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Best effort.
      }
      return { projectLabels: next };
    });
  },
}));
