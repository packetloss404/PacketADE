import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutStore } from "@/stores/layoutStore";
import { TerminalPane } from "@/components/session/TerminalPane";

vi.mock("@/hooks/useXterm", () => ({
  useXterm: vi.fn(() => ({
    xtermRef: { current: null },
    fitAddonRef: { current: null },
  })),
}));

vi.mock("@/hooks/useTerminalSession", () => ({
  useTerminalSession: vi.fn(() => ({
    alive: false,
    error: null,
    showApproval: false,
    activityInfo: { state: "idle", tool: null, file: null },
    projectPath: "/workspace",
    handleKill: vi.fn(),
    handleRestart: vi.fn(),
    handleApprove: vi.fn(),
    handleDeny: vi.fn(),
    handleAbort: vi.fn(),
    clearApproval: vi.fn(),
  })),
}));

vi.mock("@/hooks/useApprovalShortcuts", () => ({
  useApprovalShortcuts: vi.fn(),
}));

vi.mock("@/components/session/TerminalHeader", () => ({
  TerminalHeader: () => <div data-testid="terminal-header" />,
}));

vi.mock("@/components/session/ApprovalOverlay", () => ({
  ApprovalOverlay: () => <div data-testid="approval-overlay" />,
}));

vi.mock("@/components/session/ActivityStrip", () => ({
  ActivityStrip: () => <div data-testid="activity-strip" />,
}));

vi.mock("@/components/session/SessionStatusBar", () => ({
  SessionStatusBar: () => <div data-testid="session-status-bar" />,
}));

describe("TerminalPane", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      panes: [],
      activePaneId: "",
      projectPath: "/workspace",
      explorerOpen: false,
    });
  });

  it("keeps padding on the wrapper instead of the xterm host", () => {
    const { container } = render(<TerminalPane paneId="pane-1" />);
    const terminalRegion = container.querySelector(
      ".relative.flex-1.overflow-hidden",
    ) as HTMLDivElement;
    const terminalHost = terminalRegion.firstElementChild as HTMLDivElement;

    expect(terminalRegion).toHaveStyle({ padding: "4px 2px 0 4px" });
    expect(terminalHost).toHaveClass("h-full", "w-full", "overflow-hidden");
    expect(terminalHost).not.toHaveAttribute("style");
  });
});
