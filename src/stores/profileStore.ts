import { create } from "zustand";
import { loadFromStorage, saveToStorage, generateId } from "@/lib/storage";
import { storageKey } from "@/lib/brand";
import {
  SCOUT_SYSTEM_PROMPT,
  SCOUT_ALLOWED_TOOLS,
  SCOUT_MEMORY_CONTEXT_DEFAULT,
} from "@/lib/scout-config";
import type { AgentProfile } from "@/types/profiles";

const STORAGE_KEY = storageKey("agent-profiles");
const DEFAULT_PROFILE_KEY = storageKey("agent-profile-default");

/**
 * Built-in profiles ship with the app. They cannot be deleted, but a user
 * can clone any built-in into a new editable copy if they want to tweak it.
 *
 * The Reviewer profile powers the upcoming `/review` slash command (T2.10):
 * a read-only critic that's fed the staged diff and reports findings without
 * touching the worktree.
 */
const BUILTINS: AgentProfile[] = [
  {
    id: "builtin-default",
    name: "Default",
    description: "Full toolset, no system-prompt override. Standard agent.",
    systemPrompt: "",
    allowedTools: null,
    memoryContextEnabled: false,
    permissionMode: "auto",
    planMode: false,
    isBuiltin: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "builtin-scout",
    name: "Scout",
    description:
      "Read-only investigator — explores the codebase, recommends in prose. No edits or commands.",
    systemPrompt: SCOUT_SYSTEM_PROMPT,
    allowedTools: SCOUT_ALLOWED_TOOLS,
    memoryContextEnabled: SCOUT_MEMORY_CONTEXT_DEFAULT,
    permissionMode: "auto",
    planMode: true,
    isBuiltin: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "builtin-reviewer",
    name: "Reviewer",
    description:
      "Cheap critic — reads the staged diff, reports prioritized findings, never touches files.",
    systemPrompt:
      "You are a code reviewer. Read the diff and surrounding context provided in the user message. " +
      "Return a concise prioritized list of findings grouped as: 🛑 Blockers (must fix), " +
      "⚠️ Concerns (should fix), 💡 Nits (optional). For each finding cite the file and line. " +
      "Do not edit files or run commands — your only output is the review report.",
    allowedTools: ["read_file", "list_directory", "grep"],
    memoryContextEnabled: false,
    permissionMode: "auto",
    planMode: true,
    isBuiltin: true,
    createdAt: 0,
    updatedAt: 0,
  },
];

function loadProfiles(): AgentProfile[] {
  const stored = loadFromStorage<AgentProfile[]>(STORAGE_KEY, []);
  // Always re-merge built-ins so app updates pick up new ones / fixes to
  // existing ones. User-created profiles (non-builtin) are preserved as-is.
  const userOnly = stored.filter((p) => !p.isBuiltin);
  return [...BUILTINS, ...userOnly];
}

function loadDefaultId(): string {
  if (typeof localStorage === "undefined") return "builtin-default";
  try {
    return localStorage.getItem(DEFAULT_PROFILE_KEY) ?? "builtin-default";
  } catch {
    return "builtin-default";
  }
}

interface ProfileStore {
  profiles: AgentProfile[];
  /** Id of the profile currently selected as the launch default in the
   * AgentInputArea. Persisted across app restarts. */
  defaultProfileId: string;

  setDefaultProfile: (id: string) => void;
  getProfile: (id: string) => AgentProfile | undefined;
  getDefaultProfile: () => AgentProfile;

  addProfile: (
    input: Pick<
      AgentProfile,
      | "name"
      | "description"
      | "systemPrompt"
      | "allowedTools"
      | "memoryContextEnabled"
      | "permissionMode"
      | "planMode"
    >,
  ) => string;
  updateProfile: (
    id: string,
    updates: Partial<
      Pick<
        AgentProfile,
        | "name"
        | "description"
        | "systemPrompt"
        | "allowedTools"
        | "memoryContextEnabled"
        | "permissionMode"
        | "planMode"
      >
    >,
  ) => void;
  deleteProfile: (id: string) => void;
  cloneProfile: (id: string) => string | null;
}

function persist(profiles: AgentProfile[]): void {
  // Only persist user-created profiles — built-ins are re-merged on load.
  saveToStorage(STORAGE_KEY, profiles.filter((p) => !p.isBuiltin));
}

export const useProfileStore = create<ProfileStore>((set, get) => ({
  profiles: loadProfiles(),
  defaultProfileId: loadDefaultId(),

  setDefaultProfile: (id) => {
    set({ defaultProfileId: id });
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(DEFAULT_PROFILE_KEY, id);
      } catch {
        // ignore
      }
    }
  },

  getProfile: (id) => get().profiles.find((p) => p.id === id),

  getDefaultProfile: () => {
    const { profiles, defaultProfileId } = get();
    return (
      profiles.find((p) => p.id === defaultProfileId) ??
      profiles.find((p) => p.id === "builtin-default") ??
      profiles[0]
    );
  },

  addProfile: (input) => {
    const now = Date.now();
    const profile: AgentProfile = {
      id: generateId("prof"),
      name: input.name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      allowedTools: input.allowedTools,
      memoryContextEnabled: input.memoryContextEnabled,
      permissionMode: input.permissionMode,
      planMode: input.planMode,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...get().profiles, profile];
    set({ profiles: next });
    persist(next);
    return profile.id;
  },

  updateProfile: (id, updates) => {
    const next = get().profiles.map((p) =>
      p.id === id && !p.isBuiltin
        ? { ...p, ...updates, updatedAt: Date.now() }
        : p,
    );
    set({ profiles: next });
    persist(next);
  },

  deleteProfile: (id) => {
    const target = get().profiles.find((p) => p.id === id);
    if (!target || target.isBuiltin) return;
    const next = get().profiles.filter((p) => p.id !== id);
    set({ profiles: next });
    persist(next);
    // If the deleted profile was the default, fall back to builtin-default.
    if (get().defaultProfileId === id) {
      get().setDefaultProfile("builtin-default");
    }
  },

  cloneProfile: (id) => {
    const src = get().getProfile(id);
    if (!src) return null;
    return get().addProfile({
      name: `${src.name} (copy)`,
      description: src.description,
      systemPrompt: src.systemPrompt,
      allowedTools: src.allowedTools,
      memoryContextEnabled: src.memoryContextEnabled,
      permissionMode: src.permissionMode,
      planMode: src.planMode,
    });
  },
}));
