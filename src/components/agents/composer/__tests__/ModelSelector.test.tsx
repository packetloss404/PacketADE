/**
 * ModelSelector — capability first, catalog second.
 *
 * The picker used to key entirely off `API_PROVIDERS.find(p => p.agentCli ===
 * selectedAgent)` and render NOTHING when that lookup missed, which meant an
 * ACP session's real choices (enumerated by the engine over
 * `_packetcode/models/list` and carried on `caps.models`) were ignored in
 * favour of a hard-coded seed. These assertions pin both halves: the engine's
 * list wins when there is one, and every non-engine caller — which passes no
 * `models` at all — behaves exactly as it did before.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelSelector } from "@/components/agents/composer/ModelSelector";
import { API_PROVIDERS, type ApiModel } from "@/lib/api-models";
import type { AgentCli } from "@/stores/agentTaskStore";

function renderSelector(
  over: {
    selectedAgent?: AgentCli;
    selectedModel?: string;
    models?: ApiModel[];
  } = {},
) {
  const onModelChange = vi.fn();
  render(
    <ModelSelector
      dropUp
      selectedAgent={over.selectedAgent ?? ("api-packetcode" as AgentCli)}
      selectedModel={over.selectedModel ?? ""}
      onModelChange={onModelChange}
      models={over.models}
      ollamaModels={[]}
      refreshOllamaModels={vi.fn()}
    />,
  );
  return { onModelChange };
}

/** Open the drop-up and read the option rows. */
function openOptions(): string[] {
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  return screen.getAllByRole("option").map((o) => o.textContent ?? "");
}

const catalogFor = (agent: string): ApiModel[] =>
  API_PROVIDERS.find((p) => p.agentCli === agent)?.models ?? [];

describe("ModelSelector — engine models vs the seeded catalog", () => {
  it("offers the engine's list, not the catalog seed, when caps supplies one", () => {
    const engineRows: ApiModel[] = [
      { label: "glm-4.7", value: "glm-4.7" },
      { label: "kimi-k2.5", value: "kimi-k2.5" },
    ];
    renderSelector({ selectedModel: "glm-4.7", models: engineRows });

    const options = openOptions();
    expect(options).toHaveLength(2);
    expect(options[0]).toContain("glm-4.7");
    expect(options[1]).toContain("kimi-k2.5");
    // The ACP catalog row carries no static models at all, so there is nothing
    // that COULD leak in — that emptiness is the fix, and it is asserted here
    // so re-seeding the row fails this test rather than silently reinstating
    // ids the user's engine may have no provider for.
    const seeded = catalogFor("api-packetcode").map((m) => m.label);
    expect(seeded).toEqual([]);
  });

  it("keeps the picker mounted and names the engine default before the engine answers", () => {
    // Regression: the ACP row's empty catalog must not unmount the picker the
    // way an empty catalog does for a keyed provider, and the trigger must not
    // say "Select model" — there is no choice to make yet, and offering one
    // invites picking a stale id.
    renderSelector({ selectedModel: "", models: [] });
    expect(screen.getByText("Engine default")).toBeTruthy();
  });

  it("labels the trigger from the engine's list", () => {
    renderSelector({
      selectedModel: "kimi-k2.5",
      models: [
        { label: "glm-4.7", value: "glm-4.7" },
        { label: "kimi-k2.5", value: "kimi-k2.5" },
      ],
    });
    expect(screen.getByText("kimi-k2.5")).toBeTruthy();
  });

  it("selects an engine model by its own id", () => {
    const { onModelChange } = renderSelector({
      models: [{ label: "glm-4.7", value: "glm-4.7" }],
    });
    openOptions();
    fireEvent.click(screen.getByRole("option", { name: /glm-4\.7/ }));
    expect(onModelChange).toHaveBeenCalledWith("glm-4.7");
  });

  it("falls back to the catalog when caps carries nothing", () => {
    // `undefined` is "never asked / the ask failed" — the pre-engine answer.
    renderSelector({ selectedAgent: "api-claude" as AgentCli });
    const options = openOptions();
    const catalog = catalogFor("api-claude");
    expect(catalog.length).toBeGreaterThan(0);
    expect(options).toHaveLength(catalog.length);
    for (const model of catalog) {
      expect(options.some((o) => o.includes(model.label))).toBe(true);
    }
  });

  it("falls back to the catalog for an EMPTY caps list too", () => {
    renderSelector({ selectedAgent: "api-claude" as AgentCli, models: [] });
    expect(openOptions()).toHaveLength(catalogFor("api-claude").length);
  });

  it("renders nothing when neither caps nor the catalog has a row", () => {
    const { container } = render(
      <ModelSelector
        dropUp
        selectedAgent={"pty-nonesuch" as AgentCli}
        selectedModel=""
        onModelChange={vi.fn()}
        ollamaModels={[]}
        refreshOllamaModels={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("leaves Ollama on its live daemon probe, ignoring caps.models", () => {
    render(
      <ModelSelector
        dropUp
        selectedAgent={"api-ollama" as AgentCli}
        selectedModel="llama3.2"
        onModelChange={vi.fn()}
        // A caps list must not displace the installed-model probe.
        models={[{ label: "not-installed", value: "not-installed" }]}
        ollamaModels={[{ name: "llama3.2", size: 2_000_000_000, modified_at: "2026-01-01" }]}
        refreshOllamaModels={vi.fn()}
      />,
    );
    const options = openOptions();
    expect(options).toHaveLength(1);
    expect(options[0]).toContain("llama3.2");
  });
});
