import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { askSideChatStream } from "@/lib/tauri";
import { sideChatDoneEvent, sideChatErrorEvent } from "@/lib/events";
import { useAgentTaskStore } from "@/stores/agentTaskStore";

/**
 * Side chat — a Claude-Code-style ephemeral chat panel for asking quick
 * questions about the current main-thread context without polluting it.
 *
 * The store sends the user's question and a snapshot of the active main-thread
 * conversation context to the `ask_side_chat_stream` Tauri command, then
 * waits for a single `side-chat:done` event with the final answer.
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

/** How many recent main-thread messages to include as context. */
const CONTEXT_MESSAGE_LIMIT = 10;
/** Per-message truncation cap (chars) so a giant tool dump can't blow the prompt. */
const PER_MESSAGE_CHAR_CAP = 800;

/** Active event subscriptions for the in-flight request. Cleared on completion or close(). */
let unlistenDone: UnlistenFn | null = null;
let unlistenError: UnlistenFn | null = null;

function clearListeners(): void {
  if (unlistenDone) {
    unlistenDone();
    unlistenDone = null;
  }
  if (unlistenError) {
    unlistenError();
    unlistenError = null;
  }
}

/** Build a "<role>: <content>\n\n" context blob from the active conversation. */
function buildContextSnapshot(): string {
  const { conversations, selectedConversationId } = useAgentTaskStore.getState();
  if (!selectedConversationId) return "";
  const conv = conversations.find((c) => c.id === selectedConversationId);
  if (!conv || conv.messages.length === 0) return "";

  const recent = conv.messages.slice(-CONTEXT_MESSAGE_LIMIT);
  return recent
    .map((m) => {
      const content = (m.content ?? "").slice(0, PER_MESSAGE_CHAR_CAP);
      return `${m.role}: ${content}`;
    })
    .join("\n\n");
}

export const useSideChatStore = create<SideChatStore>((set, get) => ({
  open: false,
  question: "",
  answer: "",
  isStreaming: false,

  toggle: () => set((state) => ({ open: !state.open })),

  close: () => {
    clearListeners();
    set({ open: false, isStreaming: false });
  },

  setQuestion: (s) => set({ question: s }),

  ask: () => {
    const q = get().question.trim();
    if (!q || get().isStreaming) return;

    // Reset transient state and tear down any stale listeners from a previous turn.
    clearListeners();
    set({ isStreaming: true, answer: "" });

    const context = buildContextSnapshot();

    void (async () => {
      try {
        // Subscribe before invoking so we don't miss a fast response.
        unlistenDone = await listen<{ text: string }>(sideChatDoneEvent, (event) => {
          set({ answer: event.payload.text, isStreaming: false });
          clearListeners();
        });
        unlistenError = await listen<{ message: string }>(sideChatErrorEvent, (event) => {
          set({
            answer: `Error: ${event.payload.message}`,
            isStreaming: false,
          });
          clearListeners();
        });

        await askSideChatStream(q, context);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ answer: `Error: ${message}`, isStreaming: false });
        clearListeners();
      }
    })();
  },
}));
