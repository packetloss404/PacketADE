import { useCallback, useEffect, useRef, useState } from "react";
import { listOllamaModels, type OllamaModel } from "@/lib/tauri";

export type OllamaModelsState = OllamaModel[] | "loading" | { error: string };

export interface UseOllamaModelsResult {
  ollamaModels: OllamaModelsState;
  refresh: () => void;
}

/** Fetches the installed Ollama models from the local daemon. Re-runs
 * whenever the active provider becomes `api-ollama` so a freshly-switched
 * picker always shows current state. */
export function useOllamaModels(activeAgent: string): UseOllamaModelsResult {
  const [ollamaModels, setOllamaModels] =
    useState<OllamaModelsState>("loading");

  // Per-invocation epoch so toggling away from and back to api-ollama can't
  // land a stale "loading"/result over a fresh one (or setState after unmount).
  const refreshEpochRef = useRef(0);

  const refresh = useCallback(() => {
    const epoch = ++refreshEpochRef.current;
    setOllamaModels("loading");
    listOllamaModels()
      .then((models) => {
        if (refreshEpochRef.current !== epoch) return;
        setOllamaModels(models);
      })
      .catch((e: unknown) => {
        if (refreshEpochRef.current !== epoch) return;
        const message =
          e instanceof Error
            ? e.message
            : typeof e === "string"
              ? e
              : "Ollama not reachable";
        setOllamaModels({ error: message || "Ollama not reachable" });
      });
  }, []);

  useEffect(() => {
    return () => {
      // Invalidate any in-flight refresh so it can't setState after unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: this epoch counter is deliberately bumped in cleanup; it is not a stale DOM ref.
      refreshEpochRef.current++;
    };
  }, []);

  useEffect(() => {
    if (activeAgent === "api-ollama") {
      refresh();
    }
  }, [activeAgent, refresh]);

  return { ollamaModels, refresh };
}
