import { create } from "zustand";

/**
 * Side chat — a Claude-Code-style ephemeral chat panel for asking quick
 * questions about the current main-thread context without polluting it.
 *
 * v1: the `ask` action is a stub that simulates a streamed response after a
 * short delay. Real wiring to the active main-thread conversation context
 * (selectedConversationId in agentTaskStore) lands in a later phase.
 */
interface SideChatStore {
  open: boolean;
  question: string;
  answer: string;
  isStreaming: boolean;

  toggle: () => void;
  close: () => void;
  setQuestion: (s: string) => void;
  ask: () => void;
}

export const useSideChatStore = create<SideChatStore>((set, get) => ({
  open: false,
  question: "",
  answer: "",
  isStreaming: false,

  toggle: () => set((state) => ({ open: !state.open })),

  close: () => set({ open: false }),

  setQuestion: (s) => set({ question: s }),

  ask: () => {
    const q = get().question.trim();
    if (!q || get().isStreaming) return;

    set({ isStreaming: true, answer: "" });

    // v1 stub — synthetic answer to demo the flow.
    setTimeout(() => {
      set({
        answer: `Side chat answers will land in the next phase. Your question was: ${q}`,
        isStreaming: false,
      });
    }, 400);
  },
}));
