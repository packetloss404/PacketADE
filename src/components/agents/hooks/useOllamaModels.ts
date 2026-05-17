import { useCallback, useEffect, useState } from "react";
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

  const refresh = useCallback(() => {
    setOllamaModels("loading");
    listOllamaModels()
      .then((models) => {
        setOllamaModels(models);
      })
      .catch((e: unknown) => {
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
    if (activeAgent === "api-ollama") {
      refresh();
    }
  }, [activeAgent, refresh]);

  return { ollamaModels, refresh };
}
