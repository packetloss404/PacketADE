/**
 * F-2.3-15 — Ollama picker gating. A model the daemon reports as tool-less
 * (`supportsTools: false`) must render disabled in tool-carrying pickers,
 * while a model with unknown capability (old daemons report nothing) stays a
 * normal, selectable row. The backend pre-flight in `core::llm_ollama` stays
 * the enforcement point; this is UX only.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelSelector } from "@/components/agents/composer/ModelSelector";
import type { OllamaModel } from "@/lib/tauri";

const MODELS: OllamaModel[] = [
  {
    name: "qwen2.5-coder:7b",
    size: 4_683_087_519,
    modified_at: null,
    supportsTools: true,
    contextLength: 32768,
  },
  {
    name: "nomic-embed-text:latest",
    size: 274_302_450,
    modified_at: null,
    supportsTools: false,
    contextLength: 2048,
  },
  {
    // Old daemon shape: no capability data at all.
    name: "llama3:8b",
    size: 4_661_224_676,
    modified_at: null,
  },
];

function renderSelector(requiresTools: boolean, onModelChange = vi.fn()) {
  render(
    <ModelSelector
      selectedAgent="api-ollama"
      // Empty on purpose: the trigger echoes the selected model's name, and a
      // non-empty value would duplicate a row's text in the DOM.
      selectedModel=""
      onModelChange={onModelChange}
      ollamaModels={MODELS}
      refreshOllamaModels={vi.fn()}
      // Positive openSignal opens the Dropdown without a click round-trip.
      openSignal={1}
      requiresTools={requiresTools}
    />,
  );
  return onModelChange;
}

describe("ModelSelector Ollama tool gating", () => {
  it("disables a supportsTools:false row when the surface requires tools", () => {
    const onModelChange = renderSelector(true);

    expect(screen.getByText("no tools")).toBeTruthy();

    fireEvent.click(screen.getByText("nomic-embed-text:latest"));
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("keeps an unknown-capability row selectable (old daemons)", () => {
    const onModelChange = renderSelector(true);

    // Unknown capability (old daemon) must never be disabled.
    fireEvent.click(screen.getByText("llama3:8b"));
    expect(onModelChange).toHaveBeenCalledWith("llama3:8b");
  });

  it("keeps a tool-capable row selectable", () => {
    const onModelChange = renderSelector(true);

    fireEvent.click(screen.getByText("qwen2.5-coder:7b"));
    expect(onModelChange).toHaveBeenCalledWith("qwen2.5-coder:7b");
  });

  it("does not gate anything when the surface does not require tools", () => {
    const onModelChange = renderSelector(false);

    expect(screen.queryByText("no tools")).toBeNull();
    fireEvent.click(screen.getByText("nomic-embed-text:latest"));
    expect(onModelChange).toHaveBeenCalledWith("nomic-embed-text:latest");
  });
});
