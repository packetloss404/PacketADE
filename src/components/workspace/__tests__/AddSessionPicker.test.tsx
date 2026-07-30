import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddSessionPicker } from "@/components/workspace/AddSessionPicker";
import type { Workspace } from "@/types/workspace";

const addPane = vi.hoisted(() => vi.fn());
const openSettings = vi.hoisted(() => vi.fn());
const agentState = vi.hoisted(() => ({
  agents: [
    { id: "claude-code", installed: true },
    { id: "codex", installed: true },
    { id: "gemini", installed: false },
    { id: "opencode", installed: false },
    { id: "packetcode", installed: true },
  ],
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: { addPane: typeof addPane }) => unknown) =>
    selector({ addPane }),
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: (
    selector: (state: { openSettings: typeof openSettings }) => unknown,
  ) => selector({ openSettings }),
}));

vi.mock("@/stores/agentStore", () => ({
  useAgentStore: (
    selector: (state: typeof agentState) => unknown,
  ) => selector(agentState),
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: (
    selector: (state: { servers: unknown[] }) => unknown,
  ) => selector({ servers: [] }),
}));

const localWorkspace: Workspace = {
  id: "ws-local",
  name: "Local",
  agents: [],
  panes: [],
  projectPath: "/tmp/project",
  createdAt: 1,
  updatedAt: 1,
  status: "active",
};

describe("AddSessionPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentState.agents = [
      { id: "claude-code", installed: true },
      { id: "codex", installed: true },
      { id: "gemini", installed: false },
      { id: "opencode", installed: false },
      { id: "packetcode", installed: true },
    ];
  });

  function openPopover() {
    render(
      <AddSessionPicker workspace={localWorkspace} variant="popover" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add session/i }));
  }

  it("offers CLI sessions only and recommends detected PacketCode first", () => {
    openPopover();

    expect(screen.queryByText("Chat agents")).toBeNull();
    expect(screen.queryByText("Claude API")).toBeNull();
    expect(screen.getByText("CLI sessions")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();

    const buttons = screen.getAllByRole("button");
    const packetCodeIndex = buttons.findIndex((button) =>
      button.textContent?.includes("PacketCode"),
    );
    const claudeIndex = buttons.findIndex((button) =>
      button.textContent?.includes("Claude Code"),
    );
    expect(packetCodeIndex).toBeGreaterThanOrEqual(0);
    expect(packetCodeIndex).toBeLessThan(claudeIndex);
  });

  it("adds a detected PacketCode PTY pane directly", () => {
    openPopover();

    fireEvent.click(screen.getByRole("button", { name: /PacketCode/ }));

    expect(addPane).toHaveBeenCalledWith("ws-local", "packetcode");
  });

  it("routes missing PacketCode to its Settings recovery panel", () => {
    agentState.agents = agentState.agents.map((agent) =>
      agent.id === "packetcode" ? { ...agent, installed: false } : agent,
    );
    openPopover();

    fireEvent.click(screen.getAllByRole("button", { name: /set up/i })[0]);

    expect(openSettings).toHaveBeenCalledWith({
      section: "cli-clients",
      cliId: "packetcode",
    });
    expect(addPane).not.toHaveBeenCalled();
  });

  it("searches CLI sessions without surfacing API providers", () => {
    openPopover();

    fireEvent.change(screen.getByPlaceholderText("Search CLI sessions…"), {
      target: { value: "cla" },
    });

    expect(
      screen.getByRole("button", { name: "Claude Code" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("PacketCode")).toBeNull();
    expect(screen.queryByText("Claude API")).toBeNull();
  });
});
