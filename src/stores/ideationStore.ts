import { create } from "zustand";
import type { Idea, IdeationType, IdeationSession } from "@/types/ideation";
import { generateIdeas as generateIdeasApi } from "@/lib/tauri";
import { useIssueStore } from "@/stores/issueStore";
import { loadFromStorage, saveToStorage, parseJsonFromResponse, generateId } from "@/lib/storage";

const STORAGE_KEY = "packetade:ideation-sessions";

interface IdeationStore {
  sessions: Record<string, IdeationSession>;
  isGenerating: boolean;
  selectedIdeaId: string | null;

  generate: (
    workspaceId: string,
    projectPath: string,
    types: IdeationType[],
    provider: string,
    model: string,
  ) => Promise<void>;
  getSession: (workspaceId: string) => IdeationSession | null;
  dismiss: (workspaceId: string, id: string) => void;
  convertToIssue: (workspaceId: string, id: string) => void;
  clearSession: (workspaceId: string) => void;
  selectIdea: (id: string | null) => void;
}

function loadSessions(): Record<string, IdeationSession> {
  return loadFromStorage<Record<string, IdeationSession>>(STORAGE_KEY, {});
}

function saveSessions(sessions: Record<string, IdeationSession>) {
  saveToStorage(STORAGE_KEY, sessions);
}

export const useIdeationStore = create<IdeationStore>((set, get) => ({
  sessions: loadSessions(),
  isGenerating: false,
  selectedIdeaId: null,

  generate: async (workspaceId, projectPath, types, provider, model) => {
    set({ isGenerating: true });

    try {
      const raw = await generateIdeasApi(projectPath, types, provider, model);

      if (!raw || !raw.trim()) {
        throw new Error("The model returned an empty response. Try again.");
      }

      let parsed: unknown;
      try {
        parsed = parseJsonFromResponse(raw);
      } catch {
        throw new Error(`Failed to parse the model response as JSON. Raw output:\n${raw.slice(0, 500)}`);
      }

      const ideas_raw = parsed as Array<{
        type: string;
        title: string;
        description: string;
        severity: string;
        affectedFiles: string[];
        suggestion: string;
        effort: string;
      }>;

      if (!Array.isArray(ideas_raw)) {
        throw new Error(`Expected JSON array but got: ${typeof ideas_raw}`);
      }

      const ideas: Idea[] = ideas_raw.map((item) => ({
        id: generateId("idea"),
        type: item.type as IdeationType,
        title: item.title,
        description: item.description,
        severity: item.severity as Idea["severity"],
        affectedFiles: item.affectedFiles || [],
        suggestion: item.suggestion,
        effort: item.effort as Idea["effort"],
        status: "active",
      }));

      const session: IdeationSession = {
        id: generateId("idea"),
        ideas,
        config: { enabledTypes: types },
        generatedAt: Date.now(),
      };

      const sessions = { ...get().sessions, [workspaceId]: session };
      set({ sessions, isGenerating: false, selectedIdeaId: null });
      saveSessions(sessions);
    } catch (err) {
      set({ isGenerating: false });
      throw err;
    }
  },

  getSession: (workspaceId) => get().sessions[workspaceId] ?? null,

  dismiss: (workspaceId, id) => {
    const session = get().sessions[workspaceId];
    if (!session) return;
    const updated = {
      ...session,
      ideas: session.ideas.map((i) =>
        i.id === id ? { ...i, status: "dismissed" as const } : i
      ),
    };
    const sessions = { ...get().sessions, [workspaceId]: updated };
    set({ sessions, selectedIdeaId: get().selectedIdeaId === id ? null : get().selectedIdeaId });
    saveSessions(sessions);
  },

  convertToIssue: (workspaceId, id) => {
    const session = get().sessions[workspaceId];
    if (!session) return;
    const idea = session.ideas.find((i) => i.id === id);
    if (!idea || idea.status !== "active") return;

    const issue = useIssueStore.getState().addIssue({
      title: idea.title,
      description: `${idea.description}\n\n**Suggestion:** ${idea.suggestion}\n\n**Affected files:** ${idea.affectedFiles.join(", ")}`,
      status: "todo",
      priority: idea.severity === "critical" ? "critical" : idea.severity === "high" ? "high" : idea.severity === "medium" ? "medium" : "low",
      labels: [idea.type, `effort:${idea.effort}`],
      epic: null,
      acceptanceCriteria: [],
      blockedBy: [],
      blocks: [],
    });

    const updated = {
      ...session,
      ideas: session.ideas.map((i) =>
        i.id === id ? { ...i, status: "converted" as const, issueId: issue.id } : i
      ),
    };
    const sessions = { ...get().sessions, [workspaceId]: updated };
    set({ sessions });
    saveSessions(sessions);
  },

  clearSession: (workspaceId) => {
    // Destructure-and-discard idiom — `_` swallows the dropped entry, the
    // rest spread keeps the other workspaces. The eslint-disable below is
    // intentional: the variable's purpose IS being unused.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { [workspaceId]: _, ...rest } = get().sessions;
    set({ sessions: rest, selectedIdeaId: null });
    saveSessions(rest);
  },

  selectIdea: (id) => {
    set({ selectedIdeaId: id });
  },
}));
