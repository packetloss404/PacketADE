import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { bootPersistedStorage, resetStorageBootRecord } from "@/lib/storage-boot";
import { ToolsView } from "@/components/views/ToolsView";
import { useAppStore } from "@/stores/appStore";

vi.mock("@/hooks/useGitInfo", () => ({
  useGitInfo: () => "main",
}));

vi.mock("@/components/views/tools/ThemeSettingsCard", () => ({
  ThemeSettingsCard: () => <div>Theme card</div>,
}));
vi.mock("@/components/views/tools/NotificationSettingsCard", () => ({
  NotificationSettingsCard: () => <div>Notification card</div>,
}));
vi.mock("@/components/views/tools/KeyboardShortcutsCard", () => ({
  KeyboardShortcutsCard: () => <div>Keyboard card</div>,
}));
vi.mock("@/components/views/tools/ProjectInfoCard", () => ({
  ProjectInfoCard: () => <div>Project card</div>,
}));
vi.mock("@/components/views/tools/WorkspaceSettingsCard", () => ({
  WorkspaceSettingsCard: () => <div>Workspace card</div>,
}));
vi.mock("@/components/views/tools/TerminalShellSettingsCard", () => ({
  TerminalShellSettingsCard: () => <div>Terminal shell card</div>,
}));
vi.mock("@/components/views/tools/CliAgentsCard", () => ({
  CliAgentsCard: ({ focusedCliId }: { focusedCliId?: string | null }) => (
    <div>CLI clients card {focusedCliId}</div>
  ),
}));
vi.mock("@/components/views/tools/GitHubSettingsCard", () => ({
  GitHubSettingsCard: () => <div>Git hosts card</div>,
}));

describe("ToolsView six-group Settings IA", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeView: "tools",
      settingsTarget: null,
    });
  });

  it("shows six root groups and lossless sub-tabs", () => {
    render(<ToolsView />);

    for (const label of [
      "General",
      "Workspaces & Terminal",
      "Agents & Models",
      "Automation",
      "Integrations & Data",
      "Security & Diagnostics",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: "Workspaces & Terminal" }));
    expect(screen.getByRole("button", { name: "Workspace defaults" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "CLI Clients" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remote Hosts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project Rules" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "CLI Clients" }));
    expect(screen.getByText("CLI clients card")).toBeInTheDocument();
    expect(screen.getByLabelText("Setting scopes")).toHaveTextContent("New sessions");
    // First test in the file pays the full ToolsView import graph; under
    // parallel suite load that can exceed the default 5s per-test budget.
  }, 15000);

  it("searches across groups with product terminology", () => {
    render(<ToolsView />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), {
      target: { value: "forgejo" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Git Hosts/i }));

    expect(screen.getByRole("heading", { name: "Integrations & Data" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Git Hosts" })).toBeInTheDocument();
    expect(screen.getByText("Git hosts card")).toBeInTheDocument();
  });

  // The follow-up from backlog.md: the packetade migration used to report
  // success by silence. A user must be able to SEE what the boot found.
  it("surfaces the storage boot facts under Security & Diagnostics", async () => {
    // Self-contained: another test in this file may already have tripped the
    // one-shot migration guard, which would make this assert "count unknown".
    localStorage.clear();
    resetStorageBootRecord();
    await bootPersistedStorage();
    render(<ToolsView />);

    fireEvent.click(screen.getByRole("button", { name: "Security & Diagnostics" }));

    expect(screen.getByText("Storage durability")).toBeInTheDocument();
    // "found 0" has to be stated, not implied by the absence of a message.
    expect(screen.getByText(/found 0 packetade:[*] keys/)).toBeInTheDocument();
    expect(screen.getByText(/not running under Tauri/)).toBeInTheDocument();
  });

  it("keeps legacy CLI recovery deep links compatible", () => {
    useAppStore.setState({
      settingsTarget: { section: "agents", cliId: "packetcode" },
    });

    render(<ToolsView />);

    expect(screen.getByRole("heading", { name: "Workspaces & Terminal" })).toBeInTheDocument();
    expect(screen.getByText("CLI clients card packetcode")).toBeInTheDocument();
  });

});
