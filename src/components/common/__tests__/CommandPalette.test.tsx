/**
 * Command palette route coverage (audit P1-9 / decision D4).
 *
 * The palette used to maintain its own route list, which had drifted: Agents,
 * Flight Deck, Costs and the canonical Dictation destination were unreachable
 * from Ctrl+K, and Dictation could appear twice under two route identities.
 * It now renders from the one route registry.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const moduleState = vi.hoisted(() => ({
  states: { dictation: { enabled: true }, quality: { enabled: true } } as Record<
    string,
    { enabled: boolean }
  >,
}));

const promptState = vi.hoisted(() => ({
  templates: [] as unknown[],
  sendToAgentChat: vi.fn(),
}));

const makeStoreMock = vi.hoisted(
  () =>
    function makeStoreMock<S>(state: S) {
      const useStore = (selector: (s: S) => unknown) => selector(state);
      useStore.getState = () => state;
      return useStore;
    },
);

vi.mock("@/stores/moduleStore", () => ({
  useModuleStore: makeStoreMock(moduleState),
}));
vi.mock("@/stores/promptStore", () => ({
  usePromptStore: makeStoreMock(promptState),
}));

import { CommandPalette } from "@/components/common/CommandPalette";
import { useAppStore } from "@/stores/appStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

function rows(): HTMLElement[] {
  // Every result is a button; the search input is not.
  return screen.getAllByRole("button");
}

function labels(): string[] {
  return rows().map((row) => within(row).getAllByText(/.+/)[0]?.textContent ?? "");
}

describe("CommandPalette route coverage", () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView; the palette calls it on the
    // selected row after every render.
    Element.prototype.scrollIntoView = vi.fn();
    moduleState.states = { dictation: { enabled: true }, quality: { enabled: true } };
    useAppStore.setState({ activeView: "workspace", commandPaletteOpen: true });
  });

  it.each([
    ["Agents", "agents"],
    ["Flight Deck", "flights"],
    ["Cost Dashboard", "cost_dashboard"],
    ["Dictation", "dictation"],
  ] as const)("navigates to the previously missing %s destination", (label, view) => {
    render(<CommandPalette />);

    fireEvent.click(screen.getByText(label));

    expect(useAppStore.getState().activeView).toBe(view);
  });

  it.each([
    ["Workspace", "workspace"],
    ["Issues Board", "issues"],
    ["Session History", "history"],
    ["GitHub", "github"],
    ["Memory", "memory"],
    ["Settings", "tools"],
  ] as const)("keeps the pre-existing %s destination", (label, view) => {
    render(<CommandPalette />);

    fireEvent.click(screen.getByText(label));

    expect(useAppStore.getState().activeView).toBe(view);
  });

  it("lists Dictation exactly once — the module alias is not a second entry", () => {
    render(<CommandPalette />);

    expect(labels().filter((l) => l === "Dictation")).toHaveLength(1);
  });

  it("still lists ordinary modules alongside the routes", () => {
    render(<CommandPalette />);

    expect(screen.getByText("Code Quality")).toBeInTheDocument();
  });

  it("hides a route whose backing module is disabled", () => {
    moduleState.states = { dictation: { enabled: false }, quality: { enabled: true } };

    render(<CommandPalette />);

    expect(screen.queryByText("Dictation")).not.toBeInTheDocument();
  });

  it("finds Costs by keyword search", () => {
    render(<CommandPalette />);

    fireEvent.change(screen.getByPlaceholderText("Type a command..."), {
      target: { value: "spend" },
    });

    expect(screen.getByText("Cost Dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Memory")).not.toBeInTheDocument();
  });

  it("finds Flight Deck by keyword search", () => {
    render(<CommandPalette />);

    fireEvent.change(screen.getByPlaceholderText("Type a command..."), {
      target: { value: "flight" },
    });

    expect(screen.getByText("Flight Deck")).toBeInTheDocument();
  });

  it("can create a workspace — the palette is no longer navigation-only", () => {
    useWorkspaceStore.setState({ creationRequest: null });
    render(<CommandPalette />);

    fireEvent.click(screen.getByText("New Workspace"));

    expect(useWorkspaceStore.getState().creationRequest).not.toBeNull();
    expect(useAppStore.getState().activeView).toBe("workspace");
    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
  });

  it("finds the creation commands by keyword", () => {
    render(<CommandPalette />);

    fireEvent.change(screen.getByPlaceholderText("Type a command..."), {
      target: { value: "create" },
    });

    expect(screen.getByText("New Workspace")).toBeInTheDocument();
    expect(screen.queryByText("Memory")).not.toBeInTheDocument();
  });

  it("closes after executing a route action", () => {
    render(<CommandPalette />);

    fireEvent.click(screen.getByText("Agents"));

    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
  });
});
