import { useState, useRef, useCallback, useEffect } from "react";
import { askFlightChatStream } from "@/lib/tauri";
import { flightChatChunkEvent, flightChatDoneEvent, flightChatErrorEvent } from "@/lib/events";
import { useLayoutStore } from "@/stores/layoutStore";
import { useRetrospectiveStore } from "@/stores/retrospectiveStore";
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

export function useFlightChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [latestSuggestion, setLatestSuggestion] = useState<FlightSuggestion | null>(null);
  const [latestPlan, setLatestPlan] = useState<FlightPlanSuggestion | null>(null);
  const [lastError, setLastError] = useState<{ category: string; message: string; suggestion: string } | null>(null);
  const msgCounterRef = useRef(0);
  const unlistenChunkRef = useRef<UnlistenFn | null>(null);
  const unlistenDoneRef = useRef<UnlistenFn | null>(null);
  const unlistenErrorRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useRef(true);

  // Cleanup all listeners
  const cleanupListeners = useCallback(() => {
    if (unlistenChunkRef.current) {
      unlistenChunkRef.current();
      unlistenChunkRef.current = null;
    }
    if (unlistenDoneRef.current) {
      unlistenDoneRef.current();
      unlistenDoneRef.current = null;
    }
    if (unlistenErrorRef.current) {
      unlistenErrorRef.current();
      unlistenErrorRef.current = null;
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
      if (isLoading) return; // Prevent concurrent requests

      const msgId = ++msgCounterRef.current;
      const userMsg: ChatMessage = {
        id: `fc_${msgId}`,
        role: "user",
        content,
      };

      // Use functional update to avoid stale closure over messages
      let allMessages: { role: string; content: string }[] = [];
      setMessages((prev) => {
        const next = [...prev, userMsg];
        allMessages = next.map((m) => ({ role: m.role, content: m.content }));
        return next;
      });

      setIsLoading(true);
      setStreamingContent("");
      setLatestSuggestion(null);
      setLatestPlan(null);
      setLastError(null);

      // Clean up any stale listeners from prior requests
      cleanupListeners();

      let accumulated = "";
      const requestId = crypto.randomUUID();

      try {
        const unlistenChunk = await listen<string>(
          flightChatChunkEvent(requestId),
          (event) => {
            accumulated += event.payload + "\n";
            if (mountedRef.current) {
              setStreamingContent(accumulated);
            }
          },
        );
        unlistenChunkRef.current = unlistenChunk;

        // Listen for classified errors from the backend
        listen<StreamErrorEvent>(
          flightChatErrorEvent(requestId),
          (event) => {
            if (mountedRef.current) setLastError(event.payload);
          },
        ).then((unlisten) => {
          unlistenErrorRef.current = unlisten;
        });

        const donePromise = new Promise<boolean>((resolve) => {
          listen<boolean>(flightChatDoneEvent(requestId), (event) => {
            resolve(event.payload);
          }).then((unlisten) => {
            unlistenDoneRef.current = unlisten;
          });
        });

        const projectPath = useLayoutStore.getState().projectPath;
        const retroContext = useRetrospectiveStore.getState().getRetrospectiveContext();
        await askFlightChatStream(
          projectPath,
          allMessages,
          flightState,
          retroContext || undefined,
          requestId,
        );
        await donePromise;

        // Clean up listeners immediately after done
        cleanupListeners();

        if (!mountedRef.current) return;

        const finalContent = accumulated.trim();
        const assistantMsg: ChatMessage = {
          id: `fc_${++msgCounterRef.current}`,
          role: "assistant",
          content: finalContent,
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setStreamingContent("");
        setIsLoading(false);

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

        const errorMsg: ChatMessage = {
          id: `fc_${++msgCounterRef.current}`,
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        };
        setMessages((prev) => [...prev, errorMsg]);
        setStreamingContent("");
        setIsLoading(false);
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
