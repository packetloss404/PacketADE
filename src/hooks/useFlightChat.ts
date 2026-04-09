import { useState, useRef, useCallback, useEffect } from "react";
import { askFlightChatStream } from "@/lib/tauri";
import { useLayoutStore } from "@/stores/layoutStore";
import { useRetrospectiveStore } from "@/stores/retrospectiveStore";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FlightPriority } from "@/types/flight";

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
    if (["low", "medium", "high", "critical"].includes(parsed.priority)) {
      suggestion.priority = parsed.priority;
    }
    return Object.keys(suggestion).length > 0 ? suggestion : null;
  } catch {
    return null;
  }
}

export function useFlightChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [latestSuggestion, setLatestSuggestion] = useState<FlightSuggestion | null>(null);
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
      flightState: { title: string; objective: string; priority: string },
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
      setLastError(null);

      // Clean up any stale listeners from prior requests
      cleanupListeners();

      let accumulated = "";

      try {
        const unlistenChunk = await listen<string>(
          "flight-chat:chunk",
          (event) => {
            accumulated += event.payload + "\n";
            if (mountedRef.current) {
              setStreamingContent(accumulated);
            }
          },
        );
        unlistenChunkRef.current = unlistenChunk;

        // Listen for classified errors from the backend
        listen<{ category: string; message: string; suggestion: string }>(
          "flight-chat:error",
          (event) => {
            if (mountedRef.current) setLastError(event.payload);
          },
        ).then((unlisten) => {
          unlistenErrorRef.current = unlisten;
        });

        const donePromise = new Promise<boolean>((resolve) => {
          listen<boolean>("flight-chat:done", (event) => {
            resolve(event.payload);
          }).then((unlisten) => {
            unlistenDoneRef.current = unlisten;
          });
        });

        const projectPath = useLayoutStore.getState().projectPath;
        const retroContext = useRetrospectiveStore.getState().getRetrospectiveContext();
        await askFlightChatStream(projectPath, allMessages, flightState, retroContext || undefined);
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

        const suggestion = parseFlightSuggestion(finalContent);
        if (suggestion) {
          setLatestSuggestion(suggestion);
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

  return {
    messages,
    isLoading,
    streamingContent,
    latestSuggestion,
    lastError,
    sendMessage,
    dismissSuggestion,
  };
}
