/**
 * LM2 — the custom OpenAI-compatible provider row. Its models are a manual,
 * runtime-managed list (there is no discovery route across vLLM / LM Studio /
 * LiteLLM / Together), so the picker must render exactly the configured list
 * plus an "Edit models…" affordance into Settings → Providers.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { ModelSelector } from "@/components/agents/composer/ModelSelector";
import { useAppStore } from "@/stores/appStore";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "get_custom_compat_models") {
      return ["qwen2.5-72b-instruct", "llama-3.3-70b"];
    }
    return undefined;
  });
});

function renderSelector(onModelChange = vi.fn()) {
  render(
    <ModelSelector
      selectedAgent="api-custom"
      selectedModel=""
      onModelChange={onModelChange}
      ollamaModels={[]}
      refreshOllamaModels={vi.fn()}
      openSignal={1}
    />,
  );
  return onModelChange;
}

describe("ModelSelector custom endpoint branch", () => {
  it("renders the configured manual model list and selects from it", async () => {
    const onModelChange = renderSelector();

    fireEvent.click(await screen.findByText("qwen2.5-72b-instruct"));
    expect(onModelChange).toHaveBeenCalledWith("qwen2.5-72b-instruct");
  });

  it("offers an Edit models… affordance that deep-links to Settings → Providers", async () => {
    renderSelector();

    fireEvent.click(await screen.findByText("Edit models…"));
    expect(useAppStore.getState().activeView).toBe("tools");
    expect(useAppStore.getState().settingsTarget).toEqual({ section: "providers" });
  });
});
