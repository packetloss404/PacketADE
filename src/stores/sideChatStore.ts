import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { askSideChatStream, cancelSideChatStream } from "@/lib/tauri";
import { sideChatChunkEvent, sideChatDoneEvent, sideChatErrorEvent } from "@/lib/events";
import { useAgentTaskStore } from "@/stores/agentTaskStore";

/**
 * Side chat — a Claude-Code-style ephemeral chat panel for asking quick
 * questions about the current main-thread context without polluting it.
 *
 * The store sends the user's question and a snapshot of the active main-thread
 * conversation context to the `ask_side_chat_stream` Tauri command, then
 * appends each `side-chat:chunk` delta to `answer` as it streams in. A final
 * `side-chat:done` (or `side-chat:error`) terminates the stream.
 */
interface SideChatStore {
  open: boolean;
  question: string;
  answer: string;
  isStreaming: boolean;
  isStopping: boolean;
  activeRequestId: string | null;

  toggle: () => void;
  close: () => void;
  setQuestion: (s: string) => void;
  ask: () => void;
  cancel: () => void;
}

/** How many recent main-thread messages to include as context. */
const CONTEXT_MESSAGE_LIMIT = 10;
/** Per-message truncation cap (chars) so a giant tool dump can't blow the prompt. */
const PER_MESSAGE_CHAR_CAP = 800;

/** Listener ownership is request-scoped. A late registration from request A
 * must never clear request B's listeners after A was closed/replaced. */
let activeListeners: { requestId: string; cleanup: () => void } | null = null;

interface SideChatChunkPayload {
  requestId: string;
  delta: string;
}

interface SideChatDonePayload {
  requestId: string;
  cancelled: boolean;
}

interface SideChatErrorPayload {
  requestId: string;
  message: string;
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `side-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clearListeners(requestId?: string): void {
  if (!activeListeners) return;
  if (requestId && activeListeners.requestId !== requestId) return;
  const listeners = activeListeners;
  activeListeners = null;
  listeners.cleanup();
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
  isStopping: false,
  activeRequestId: null,

  toggle: () => {
    if (get().open) {
      get().close();
      return;
    }
    set({ open: true });
  },

  close: () => {
    const requestId = get().activeRequestId;
    clearListeners(requestId ?? undefined);
    set({ open: false, isStreaming: false, isStopping: false, activeRequestId: null });
    if (requestId) {
      void cancelSideChatStream(requestId).catch((error) => {
        console.warn("cancel_side_chat_stream failed while closing:", error);
      });
    }
  },

  setQuestion: (s) => set({ question: s }),

  ask: () => {
    const q = get().question.trim();
    if (!q || get().isStreaming) return;

    // Reset transient state and tear down any stale listeners from a previous turn.
    clearListeners();
    const requestId = newRequestId();
    set({ isStreaming: true, isStopping: false, answer: "", activeRequestId: requestId });

    const context = buildContextSnapshot();

    void (async () => {
      const localListeners: UnlistenFn[] = [];
      const cleanupLocal = () => {
        for (const unlisten of localListeners.splice(0)) unlisten();
      };
      const stillOwned = () => get().activeRequestId === requestId;
      try {
        // Subscribe before invoking so we don't miss a fast response.
        localListeners.push(
          await listen<SideChatChunkPayload>(sideChatChunkEvent, (event) => {
            if (event.payload?.requestId !== requestId || get().activeRequestId !== requestId)
              return;
            const delta = event.payload.delta ?? "";
            if (!delta) return;
            set((state) => ({ answer: state.answer + delta }));
          }),
        );
        if (!stillOwned()) {
          cleanupLocal();
          return;
        }
        localListeners.push(
          await listen<SideChatDonePayload>(sideChatDoneEvent, (event) => {
            if (event.payload?.requestId !== requestId || get().activeRequestId !== requestId)
              return;
            set({ isStreaming: false, isStopping: false, activeRequestId: null });
            clearListeners(requestId);
          }),
        );
        if (!stillOwned()) {
          cleanupLocal();
          return;
        }
        localListeners.push(
          await listen<SideChatErrorPayload>(sideChatErrorEvent, (event) => {
            if (event.payload?.requestId !== requestId || get().activeRequestId !== requestId)
              return;
            set({
              answer: `Error: ${event.payload.message}`,
              isStreaming: false,
              isStopping: false,
              activeRequestId: null,
            });
            clearListeners(requestId);
          }),
        );

        // The overlay may have closed while async listener registration was
        // in flight. In that case never start an orphaned backend request.
        if (!stillOwned()) {
          cleanupLocal();
          return;
        }
        activeListeners = { requestId, cleanup: cleanupLocal };

        await askSideChatStream(requestId, q, context);
        // Close or Stop can race the command before Rust registers its token.
        // Once ask returns, begin/spawn has completed, so retry cancellation
        // against the now-authoritative registry.
        if (!stillOwned()) {
          await cancelSideChatStream(requestId);
          return;
        }
        if (get().isStopping) {
          const accepted = await cancelSideChatStream(requestId);
          if (!accepted && stillOwned()) {
            set({
              answer: "Error: Side chat could not confirm the Stop request.",
              isStreaming: false,
              isStopping: false,
              activeRequestId: null,
            });
            clearListeners(requestId);
          }
        }
      } catch (err) {
        clearListeners(requestId);
        cleanupLocal();
        if (get().activeRequestId !== requestId) return;
        const message = err instanceof Error ? err.message : String(err);
        set({
          answer: `Error: ${message}`,
          isStreaming: false,
          isStopping: false,
          activeRequestId: null,
        });
      }
    })();
  },

  cancel: () => {
    const requestId = get().activeRequestId;
    if (!requestId || get().isStopping) return;
    set({ isStopping: true });
    void cancelSideChatStream(requestId)
      .then((accepted) => {
        // `false` can mean Stop beat `ask_side_chat_stream` to Rust's request
        // registry. The post-ask retry above owns that startup race.
        if (!accepted) return;
      })
      .catch((error) => {
        if (get().activeRequestId !== requestId) return;
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          answer: `${state.answer}${state.answer ? "\n\n" : ""}Error: Stop failed: ${message}`,
          isStopping: false,
        }));
      });
  },
}));
