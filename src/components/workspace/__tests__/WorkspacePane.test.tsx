import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePane } from "@/components/workspace/WorkspacePane";
import type { TerminalHeaderRenderState } from "@/components/session/TerminalPane";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentStore } from "@/stores/agentStore";
import { CODEX_CONFIG } from "@/agents/codex";
import { OPENCODE_CONFIG } from "@/agents/opencode";
import { TERMINAL_CONFIG } from "@/agents/terminal";
import { useTerminalSettingsStore } from "@/stores/terminalSettingsStore";
import type { Workspace } from "@/types/workspace";

// The tile header lives entirely inside WorkspacePane's `renderHeader`
// callback passed to TerminalPane. Mounting the real TerminalPane would
// pull in xterm/PTY plumbing this suite doesn't need — mock it down to a
// component that invokes `renderHeader` with a test-controlled state and
// renders the result, mirroring TerminalHeaderRenderState's real shape
// (TerminalPane.tsx:12).
let currentHeaderState: TerminalHeaderRenderState = {
  alive: true,
  error: null,
  showApproval: false,
  cliCommand: "codex",
  onRestart: vi.fn(),
  onKill: vi.fn(),
};
let lastTerminalProps: Record<string, unknown> = {};

vi.mock("@/components/session/TerminalPane", () => ({
  TerminalPane: (props: {
    renderHeader?: (state: TerminalHeaderRenderState) => React.ReactNode;
    [key: string]: unknown;
  }) => {
    lastTerminalProps = props;
    return <>{props.renderHeader ? props.renderHeader(currentHeaderState) : null}</>;
  },
}));

// WorkspacePane reaches for MosaicWindowContext to wire the drag source.
// Outside a <MosaicWindow> provider, React's useContext naturally resolves
// to the context's own default (`undefined`, per react-mosaic-component's
// contextTypes.ts) — the code already null-guards on that (`?? fullHeader`),
// so no explicit mock is needed here.

function makeWorkspace(): Workspace {
  const now = Date.now();
  return {
    id: "ws-1",
    name: "Header diet test workspace",
    agents: ["codex", "opencode", "terminal"],
    panes: [
      { id: "pane-codex", agentId: "codex", sessionId: null },
      { id: "pane-opencode", agentId: "opencode", sessionId: null },
      { id: "pane-terminal", agentId: "terminal", sessionId: null },
    ],
    projectPath: "/tmp/project",
    createdAt: now,
    updatedAt: now,
    status: "active",
  };
}

describe("WorkspacePane tile header", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaces: [makeWorkspace()],
      activeWorkspaceId: "ws-1",
      zoomedPaneId: null,
    });
    useAgentStore.setState({
      agents: [
        { ...CODEX_CONFIG, installed: true },
        { ...OPENCODE_CONFIG, installed: true },
        { ...TERMINAL_CONFIG, installed: true },
      ],
      detecting: false,
    });
    currentHeaderState = {
      alive: true,
      error: null,
      showApproval: false,
      cliCommand: "codex",
      onRestart: vi.fn(),
      onKill: vi.fn(),
    };
    lastTerminalProps = {};
    useTerminalSettingsStore.setState({ defaultShell: { profile: "auto" } });
  });

  it("renders a diet header: grip, dot, name, status, zoom, one overflow — no standalone accent/pin/prompt/model controls", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    render(<WorkspacePane pane={workspace.panes[0]} workspaceId={workspace.id} />);

    // The old per-pane accent-color picker is gone.
    expect(screen.queryByTitle("Change accent color")).not.toBeInTheDocument();
    // Standalone Pin / prompt-template / model-chip buttons are gone —
    // they now live inside the single overflow menu.
    expect(screen.queryByTitle("Pinned commands")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Send a prompt template to this pane")).not.toBeInTheDocument();
    expect(screen.queryByTitle(/change model/i)).not.toBeInTheDocument();

    // Zoom stays a direct header control.
    expect(screen.getByTitle("Zoom to focus")).toBeInTheDocument();

    // Exactly one overflow trigger.
    expect(screen.getByTitle("More")).toBeInTheDocument();
  });

  it("codex identity resolves via lib/agentColors (text-accent-amber)", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    render(<WorkspacePane pane={workspace.panes[0]} workspaceId={workspace.id} />);

    const name = screen.getByText(CODEX_CONFIG.name);
    expect(name.className).toContain("text-accent-amber");
  });

  it("opencode identity resolves to a different agentColors token (text-accent-purple) — proves the divergent per-file maps died", () => {
    currentHeaderState = { ...currentHeaderState, cliCommand: "opencode" };
    const workspace = useWorkspaceStore.getState().workspaces[0];
    render(<WorkspacePane pane={workspace.panes[1]} workspaceId={workspace.id} />);

    const name = screen.getByText(OPENCODE_CONFIG.name);
    expect(name.className).toContain("text-accent-purple");
    expect(name.className).not.toContain("text-accent-amber");
  });

  it("confirms before Close pane stops a live PTY and removes the pane", () => {
    const workspace = useWorkspaceStore.getState().workspaces[0];
    const removePaneSpy = vi.spyOn(useWorkspaceStore.getState(), "removePane");

    render(<WorkspacePane pane={workspace.panes[0]} workspaceId={workspace.id} />);

    fireEvent.click(screen.getByTitle("More"));
    expect(screen.getByText("Restart session")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Close pane"));
    expect(screen.getByText("Close terminal pane?")).toBeInTheDocument();
    expect(
      screen.getByText("Any live PTY and CLI process in this pane will be stopped."),
    ).toBeInTheDocument();
    expect(removePaneSpy).not.toHaveBeenCalled();
    expect(currentHeaderState.onKill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Close terminal pane?")).not.toBeInTheDocument();
    expect(removePaneSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("More"));
    fireEvent.click(screen.getByText("Close pane"));
    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));

    expect(currentHeaderState.onKill).toHaveBeenCalledTimes(1);
    expect(removePaneSpy).toHaveBeenCalledWith(workspace.id, "pane-codex");
  });

  it("applies the selected shell only to a raw local Terminal pane", () => {
    useTerminalSettingsStore.setState({
      defaultShell: { profile: "command-prompt", executable: "cmd.exe" },
    });
    const workspace = useWorkspaceStore.getState().workspaces[0];

    const { unmount } = render(
      <WorkspacePane pane={workspace.panes[2]} workspaceId={workspace.id} />,
    );
    expect(lastTerminalProps.cliCommand).toBe("cmd.exe");
    expect(lastTerminalProps.cliArgs).toBeUndefined();

    unmount();
    render(<WorkspacePane pane={workspace.panes[0]} workspaceId={workspace.id} />);
    expect(lastTerminalProps.cliCommand).toBe("codex");
  });

  it("uses pane override before workspace and app shell defaults", () => {
    useTerminalSettingsStore.setState({ defaultShell: { profile: "command-prompt" } });
    const workspace = useWorkspaceStore.getState().workspaces[0];
    workspace.terminalShell = { profile: "powershell7" };
    const pane = {
      ...workspace.panes[2],
      terminalShell: { profile: "wsl" as const, wslDistro: "Ubuntu" },
    };

    render(<WorkspacePane pane={pane} workspaceId={workspace.id} />);

    expect(lastTerminalProps.cliCommand).toBe("wsl");
    expect(lastTerminalProps.cliArgs).toEqual(["--distribution", "Ubuntu"]);
  });
});
