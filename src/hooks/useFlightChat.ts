import { useState, useRef, useCallback, useEffect } from "react";
import { askFlightChatStream } from "@/lib/tauri";
import { flightChatChunkEvent, flightChatDoneEvent, flightChatErrorEvent } from "@/lib/events";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FlightPriority, TaskType } from "@/types/flight";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface FlightSuggestion {
  title?: string;
  objective?: string;
  priority?: FlightPriority;
}

export interface FlightPlanTask {
  title: string;
  description: string;
  type: TaskType;
  dependsOn: string[];
}

export interface FlightPlanMilestone {
  title: string;
  description: string;
  validationCriteria: string[];
  tasks: FlightPlanTask[];
}

export interface FlightPlanSuggestion {
  title?: string;
  objective?: string;
  priority?: FlightPriority;
  milestones: FlightPlanMilestone[];
}

interface StreamErrorEvent {
  category: string;
  message: string;
  suggestion: string;
}

export type FlightChatError = StreamErrorEvent;

const VALID_PRIORITIES = ["low", "medium", "high", "critical"];
const VALID_TASK_TYPES = ["implementation", "testing", "review", "validation", "research", "refactor", "documentation"];

function parseFlightSuggestion(content: string): FlightSuggestion | null {
  const match = content.match(/```json:flight\s*\n([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    const suggestion: FlightSuggestion = {};
    if (typeof parsed.title === "string" && parsed.title.trim()) {
      suggestion.title = parsed.title.trim();
    }
    if (typeof parsed.objective === "string") {
      suggestion.objective = parsed.objective.trim();
    }
    if (VALID_PRIORITIES.includes(parsed.priority)) {
      suggestion.priority = parsed.priority;
    }
    return Object.keys(suggestion).length > 0 ? suggestion : null;
  } catch {
    return null;
  }
}

function parseFlightPlan(content: string): FlightPlanSuggestion | null {
  const match = content.match(/```json:flight-plan\s*\n([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (!Array.isArray(parsed.milestones) || parsed.milestones.length === 0) return null;

    const milestones: FlightPlanMilestone[] = [];
    for (const ms of parsed.milestones) {
      if (typeof ms.title !== "string" || !ms.title.trim()) continue;
      const tasks: FlightPlanTask[] = [];
      if (Array.isArray(ms.tasks)) {
        for (const t of ms.tasks) {
          if (typeof t.title !== "string" || !t.title.trim()) continue;
          tasks.push({
            title: t.title.trim(),
            description: typeof t.description === "string" ? t.description.trim() : "",
            type: VALID_TASK_TYPES.includes(t.type) ? t.type : "implementation",
            dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d: unknown) => typeof d === "string") : [],
          });
        }
      }
      milestones.push({
        title: ms.title.trim(),
        description: typeof ms.description === "string" ? ms.description.trim() : "",
        validationCriteria: Array.isArray(ms.validationCriteria)
          ? ms.validationCriteria.filter((c: unknown) => typeof c === "string")
          : [],
        tasks,
      });
    }

    if (milestones.length === 0) return null;

    const plan: FlightPlanSuggestion = { milestones };
    if (typeof parsed.title === "string" && parsed.title.trim()) {
      plan.title = parsed.title.trim();
    }
    if (typeof parsed.objective === "string") {
      plan.objective = parsed.objective.trim();
    }
    if (VALID_PRIORITIES.includes(parsed.priority)) {
      plan.priority = parsed.priority;
    }
    return plan;
  } catch {
    return null;
  }
}

interface FlightChatStreamHandlers {
  onChunk: (chunk: string) => void;
  onError: (err: StreamErrorEvent) => void;
  onDone: (success: boolean) => void;
}

interface FlightChatStreamSubscription {
  unlisten: () => void;
  done: Promise<boolean>;
}

// Wires up the chunk/error/done listeners for a single ask_flight_chat_stream
// request. Subscription order (chunk → error → done) is load-bearing for the
// useFlightChat tests; keep it.
async function subscribeToFlightChatStream(
  requestId: string,
  handlers: FlightChatStreamHandlers,
): Promise<FlightChatStreamSubscription> {
  let resolveDone: (success: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve;
  });

  const [unlistenChunk, unlistenError, unlistenDone] = await Promise.all([
    listen<string>(flightChatChunkEvent(requestId), (event) => {
      handlers.onChunk(event.payload);
    }),
    listen<StreamErrorEvent>(flightChatErrorEvent(requestId), (event) => {
      handlers.onError(event.payload);
    }),
    listen<boolean>(flightChatDoneEvent(requestId), (event) => {
      handlers.onDone(event.payload);
      resolveDone(event.payload);
    }),
  ]);

  return {
    unlisten: () => {
      unlistenChunk();
      unlistenError();
      unlistenDone();
    },
    done,
  };
}

export function useFlightChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [latestSuggestion, setLatestSuggestion] = useState<FlightSuggestion | null>(null);
  const [latestPlan, setLatestPlan] = useState<FlightPlanSuggestion | null>(null);
  const [lastError, setLastError] = useState<FlightChatError | null>(null);
  const msgCounterRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  const inFlightRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);

  // Cleanup all listeners
  const cleanupListeners = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupListeners();
    };
  }, [cleanupListeners]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const sendMessage = useCallback(
    async (
      content: string,
      flightState: {
        title: string;
        objective: string;
        priority: string;
        milestones?: Array<{ title: string; tasks: Array<{ title: string; type: string }> }>;
      },
    ) => {
      if (inFlightRef.current || isLoading) return; // Prevent concurrent requests, including same-tick sends

      inFlightRef.current = true;

      const msgId = ++msgCounterRef.current;
      const userMsg: ChatMessage = {
        id: `fc_${msgId}`,
        role: "user",
        content,
      };

      const nextMessages = [...messagesRef.current, userMsg];
      messagesRef.current = nextMessages;
      const allMessages = nextMessages.map((m) => ({ role: m.role, content: m.content }));
      setMessages(nextMessages);

      setIsLoading(true);
      setStreamingContent("");
      setLatestSuggestion(null);
      setLatestPlan(null);
      setLastError(null);

      // Clean up any stale listeners from prior requests
      cleanupListeners();

      let accumulated = "";
      const requestId = crypto.randomUUID();
      let backendError: FlightChatError | null = null;

      try {
        const subscription = await subscribeToFlightChatStream(requestId, {
          onChunk: (chunk) => {
            accumulated += chunk + "\n";
            if (mountedRef.current) {
              setStreamingContent(accumulated);
            }
          },
          onError: (err) => {
            backendError = err;
            if (mountedRef.current) setLastError(err);
          },
          onDone: () => {
            /* resolution handled via subscription.done */
          },
        });
        unlistenRef.current = subscription.unlisten;

        const projectPath = useLayoutStore.getState().projectPath;
        const retroContext = useMemoryStore.getState().getContextForSession(projectPath);
        await askFlightChatStream(
          projectPath,
          allMessages,
          flightState,
          retroContext || undefined,
          requestId,
        );
        const doneOk = await subscription.done;

        // Clean up listeners immediately after done
        cleanupListeners();

        if (!mountedRef.current) return;

        const finalContent = accumulated.trim();
        if (!doneOk) {
          const streamError = backendError ?? {
            category: "stream",
            message: "Flight planner stopped before finishing.",
            suggestion: "Try again or adjust the prompt.",
          };
          setLastError(streamError);
          const errorMsg: ChatMessage = {
            id: `fc_${++msgCounterRef.current}`,
            role: "assistant",
            content: `Error: ${streamError.message}\n\n${streamError.suggestion}`,
          };
          setMessages((prev) => {
            const next = [...prev, errorMsg];
            messagesRef.current = next;
            return next;
          });
          setStreamingContent("");
          return;
        }

        const assistantMsg: ChatMessage = {
          id: `fc_${++msgCounterRef.current}`,
          role: "assistant",
          content: finalContent,
        };
        setMessages((prev) => {
          const next = [...prev, assistantMsg];
          messagesRef.current = next;
          return next;
        });
        setStreamingContent("");

        // Try flight-plan first (superset), fall back to basic flight suggestion
        const plan = parseFlightPlan(finalContent);
        if (plan) {
          setLatestPlan(plan);
          // Also set suggestion for basic fields if present in the plan
          const suggestion: FlightSuggestion = {};
          if (plan.title) suggestion.title = plan.title;
          if (plan.objective) suggestion.objective = plan.objective;
          if (plan.priority) suggestion.priority = plan.priority;
          if (Object.keys(suggestion).length > 0) {
            setLatestSuggestion(suggestion);
          }
        } else {
          const suggestion = parseFlightSuggestion(finalContent);
          if (suggestion) {
            setLatestSuggestion(suggestion);
          }
        }
      } catch (err) {
        cleanupListeners();
        if (!mountedRef.current) return;

        const error = {
          category: "request",
          message: err instanceof Error ? err.message : String(err),
          suggestion: "Try again or check the backend logs.",
        };
        setLastError(error);
        const errorMsg: ChatMessage = {
          id: `fc_${++msgCounterRef.current}`,
          role: "assistant",
          content: `Error: ${error.message}`,
        };
        setMessages((prev) => {
          const next = [...prev, errorMsg];
          messagesRef.current = next;
          return next;
        });
        setStreamingContent("");
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) {
          setIsLoading(false);
        }
      }
    },
    [isLoading, cleanupListeners],
  );

  const dismissSuggestion = useCallback(() => {
    setLatestSuggestion(null);
  }, []);

  const dismissPlan = useCallback(() => {
    setLatestPlan(null);
  }, []);

  return {
    messages,
    isLoading,
    streamingContent,
    latestSuggestion,
    latestPlan,
    lastError,
    sendMessage,
    dismissSuggestion,
    dismissPlan,
  };
}
