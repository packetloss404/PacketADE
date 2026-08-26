import { useCallback, useEffect, useRef, useState } from "react";
import { getCustomCompatModels } from "@/lib/tauri";

export type CustomModelsState = string[] | "loading" | { error: string };

export interface UseCustomModelsResult {
  customModels: CustomModelsState;
  refresh: () => void;
}

/** LM2 — the manual model list for the custom OpenAI-compatible endpoint.
 * Mirrors `useOllamaModels`: fetches whenever the active provider becomes
 * `api-custom` so a freshly-switched picker always shows the current list
 * (edited in Settings → Tools → Provider Endpoints). */
export function useCustomModels(activeAgent: string): UseCustomModelsResult {
  const [customModels, setCustomModels] = useState<CustomModelsState>("loading");

  // Per-invocation epoch so toggling away and back can't land a stale
  // result over a fresh one (or setState after unmount).
  const refreshEpochRef = useRef(0);

  const refresh = useCallback(() => {
    const epoch = ++refreshEpochRef.current;
    setCustomModels("loading");
    getCustomCompatModels()
      .then((models) => {
        if (refreshEpochRef.current !== epoch) return;
        setCustomModels(models ?? []);
      })
      .catch((e: unknown) => {
        if (refreshEpochRef.current !== epoch) return;
        const message =
          e instanceof Error
            ? e.message
            : typeof e === "string"
              ? e
              : "Failed to load model list";
        setCustomModels({ error: message || "Failed to load model list" });
      });
  }, []);

  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: this epoch counter is deliberately bumped in cleanup; it is not a stale DOM ref.
      refreshEpochRef.current++;
    };
  }, []);

  useEffect(() => {
    if (activeAgent === "api-custom") {
      refresh();
    }
  }, [activeAgent, refresh]);

  return { customModels, refresh };
}
