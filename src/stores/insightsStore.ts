import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { askInsightsStream } from "@/lib/tauri";
import { generateId, loadFromStorage, saveToStorage } from "@/lib/storage";
import type { InsightsMessage, InsightsSession } from "@/types/insights";
import { useMemoryStore } from "@/stores/memoryStore";

const STORAGE_KEY = "packetcode:insights";

interface InsightsStore {
  sessions: InsightsSession[];
  activeSessionId: string | null;
  isStreaming: boolean;
  includeMemoryContext: boolean;

  createSession: () => string;
  deleteSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  sendMessage: (projectPath: string, content: string) => Promise<void>;
  associateWithFlight: (sessionId: string, flightId: string) => void;
  setIncludeMemoryContext: (include: boolean) => void;
}

function persist(sessions: InsightsSession[]) {
  saveToStorage(STORAGE_KEY, sessions);
}

export const useInsightsStore = create<InsightsStore>((set, get) => ({
  sessions: loadFromStorage<InsightsSession[]>(STORAGE_KEY, []),
  activeSessionId: null,
  isStreaming: false,
  includeMemoryContext: true,

  createSession: () => {
    const id = generateId("ins");
    const session: InsightsSession = {
      id,
      title: "New conversation",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const sessions = [session, ...get().sessions];
    set({ sessions, activeSessionId: id });
    persist(sessions);
    return id;
  },

  deleteSession: (id: string) => {
    const sessions = get().sessions.filter((s) => s.id !== id);
    const activeSessionId =
      get().activeSessionId === id
        ? sessions[0]?.id ?? null
        : get().activeSessionId;
    set({ sessions, activeSessionId });
    persist(sessions);
  },

  setActiveSession: (id: string) => {
    set({ activeSessionId: id });
  },

  setIncludeMemoryContext: (include: boolean) => {
    set({ includeMemoryContext: include });
  },

  associateWithFlight: (sessionId: string, flightId: string) => {
    const sessions = get().sessions.map((s) =>
      s.id === sessionId ? { ...s, flightId, updatedAt: Date.now() } : s,
    );
    set({ sessions });
    persist(sessions);
  },

  sendMessage: async (projectPath: string, content: string) => {
    const state = get();
    let sessionId = state.activeSessionId;
    if (!sessionId) {
      sessionId = get().createSession();
    }

    const userMsg: InsightsMessage = {
      id: generateId("msg"),
      role: "user",
      content,
      timestamp: Date.now(),
    };

    // Add user message
    const sessionsWithUser = get().sessions.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            messages: [...s.messages, userMsg],
            title: s.messages.length === 0 ? content.slice(0, 60) : s.title,
            updatedAt: Date.now(),
          }
        : s,
    );
    set({ sessions: sessionsWithUser, isStreaming: true });
    persist(sessionsWithUser);

    // Prepare assistant message placeholder
    const assistantMsg: InsightsMessage = {
      id: generateId("msg"),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };

    const sessionsWithAssistant = get().sessions.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            messages: [...s.messages, assistantMsg],
            updatedAt: Date.now(),
          }
        : s,
    );
    set({ sessions: sessionsWithAssistant });

    const requestId = generateId("req");
    const assistantMsgId = assistantMsg.id;
    const unlisteners: UnlistenFn[] = [];

    try {
      // Build messages for backend (role + content only)
      const session = get().sessions.find((s) => s.id === sessionId);
      const backendMessages = (session?.messages ?? [])
        .filter((m) => m.id !== assistantMsgId)
        .map((m) => ({ role: m.role, content: m.content }));

      // Listen for chunk events
      const chunkUn = await listen<string>(
        `insights:chunk:${requestId}`,
        (event) => {
          const sessions = get().sessions.map((s) => {
            if (s.id !== sessionId) return s;
            return {
              ...s,
              messages: s.messages.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, content: m.content + event.payload + "\n" }
                  : m,
              ),
              updatedAt: Date.now(),
            };
          });
          set({ sessions });
        },
      );
      unlisteners.push(chunkUn);

      // Listen for error events
      const errorUn = await listen<string>(
        `insights:error:${requestId}`,
        (event) => {
          const sessions = get().sessions.map((s) => {
            if (s.id !== sessionId) return s;
            return {
              ...s,
              messages: s.messages.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, content: m.content + "\n\n**Error:** " + event.payload }
                  : m,
              ),
              updatedAt: Date.now(),
            };
          });
          set({ sessions, isStreaming: false });
          persist(sessions);
          unlisteners.forEach((u) => u());
        },
      );
      unlisteners.push(errorUn);

      // Listen for done events
      const doneUn = await listen<string>(
        `insights:done:${requestId}`,
        () => {
          const sessions = get().sessions;
          set({ isStreaming: false });
          persist(sessions);
          unlisteners.forEach((u) => u());
        },
      );
      unlisteners.push(doneUn);

      // Build memory context if enabled
      const sessionContext = get().includeMemoryContext
        ? useMemoryStore.getState().getContextForSession(projectPath) || null
        : null;

      // Invoke backend
      await askInsightsStream(
        projectPath,
        backendMessages,
        sessionContext,
        requestId,
      );
    } catch (err) {
      // On invoke error, update the assistant message with the error
      const sessions = get().sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          messages: s.messages.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: `**Error:** ${String(err)}` }
              : m,
          ),
          updatedAt: Date.now(),
        };
      });
      set({ sessions, isStreaming: false });
      persist(sessions);
      unlisteners.forEach((u) => u());
    }
  },
}));
