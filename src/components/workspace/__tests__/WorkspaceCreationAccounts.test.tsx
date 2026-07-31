import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import type { CliAccount } from "@/types/cliAccount";

/**
 * Multi-account CLI support — the New Workspace modal's per-slot account
 * selector. The modal's project path can change while it is open, so the
 * pre-fill has to re-resolve rather than latch at mount.
 */

const LOCAL_PATH = "C:\\projects\\client-app";
const OTHER_PATH = "C:\\projects\\oss-lib";

const mocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(() => "ws-new"),
  setActiveView: vi.fn(),
  openSettings: vi.fn(),
  workspaces: [] as unknown[],
}));

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    // Auto-bind probe — irrelevant here, but it fires on every path change.
    gitGetOriginUrl: vi.fn().mockResolvedValue(null),
    sshCheckRemotePath: vi.fn().mockResolvedValue({
      exists: true,
      isDirectory: true,
      isGitRepo: false,
    }),
    saveCliAccountsSlice: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/stores/workspaceStore", () => {
  const state = {
    createWorkspace: mocks.createWorkspace,
    defaultBypassPermissions: false,
    autoBindGithubRepo: false,
    // Getter so a test can retarget the recent-paths list after module init.
    get workspaces() {
      return mocks.workspaces;
    },
  };
  const useWorkspaceStore = Object.assign(
    vi.fn((selector: (s: typeof state) => unknown) => selector(state)),
    { getState: vi.fn(() => state) },
  );
  return { useWorkspaceStore };
});

vi.mock("@/stores/appStore", () => {
  const state = { setActiveView: mocks.setActiveView, openSettings: mocks.openSettings };
  return {
    useAppStore: Object.assign(
      vi.fn((selector: (s: typeof state) => unknown) => selector(state)),
      { getState: vi.fn(() => state) },
    ),
  };
});

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: vi.fn((selector: (s: { projectPath: string }) => unknown) =>
    selector({ projectPath: LOCAL_PATH }),
  ),
}));

vi.mock("@/stores/agentStore", () => {
  const state = {
    agents: [
      { id: "claude-code", installed: true },
      { id: "codex", installed: true },
      { id: "opencode", installed: true },
      { id: "packetcode", installed: true },
    ],
    detecting: false,
  };
  return {
    useAgentStore: Object.assign(
      vi.fn((selector: (s: typeof state) => unknown) => selector(state)),
      { getState: vi.fn(() => state) },
    ),
  };
});

vi.mock("@/stores/serverStore", () => {
  const state = { servers: [] };
  return {
    useServerStore: Object.assign(
      vi.fn((selector: (s: typeof state) => unknown) => selector(state)),
      { getState: vi.fn(() => state) },
    ),
  };
});

vi.mock("@/stores/promptStore", () => ({
  usePromptStore: vi.fn((selector: (s: { templates: unknown[] }) => unknown) =>
    selector({ templates: [] }),
  ),
}));

function account(id: string, label: string, cli: CliAccount["cli"]): CliAccount {
  return { id, label, cli, configDir: `C:\\cfg\\${id}`, createdAt: 1 };
}

/** The account controls live inside the collapsed Advanced accordion. */
function openAdvanced() {
  const toggle = screen
    .getAllByRole("button")
    .find((button) => /advanced/i.test(button.textContent ?? ""));
  if (toggle) fireEvent.click(toggle);
}

describe("WorkspaceCreationModal — account selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useCliAccountStore.setState({ accounts: [], stickyDefaults: {} });
  });

  it("renders no account control when the user has registered no accounts", () => {
    render(
      <WorkspaceCreationModal
        onClose={() => {}}
        initialSelected={new Set(["claude-code"])}
      />,
    );
    openAdvanced();

    expect(screen.queryByText("Claude Code Account")).toBeNull();
  });

  it("pre-fills each selected slot from the sticky default for the chosen project path", () => {
    useCliAccountStore.setState({
      accounts: [
        account("acct-client", "Client work", "claude-code"),
        account("acct-personal", "Personal", "claude-code"),
        account("acct-codex", "Codex login", "codex"),
      ],
      stickyDefaults: { [LOCAL_PATH]: { "claude-code": "acct-client" } },
    });

    render(
      <WorkspaceCreationModal
        onClose={() => {}}
        initialSelected={new Set(["claude-code", "codex"])}
      />,
    );
    openAdvanced();

    expect(screen.getByText("Claude Code Account")).toBeInTheDocument();
    expect(screen.getByText("Codex CLI Account")).toBeInTheDocument();
    expect(screen.getByText("Client work")).toBeInTheDocument();
    // codex has an account registered but no sticky entry for this path.
    expect(screen.getByText("Default login")).toBeInTheDocument();
    // Non-account-aware slots get no control at all.
    expect(screen.queryByText("Terminal Account")).toBeNull();
    expect(screen.queryByText("OpenCode Account")).toBeNull();
  });

  it("re-resolves the pre-fill when the project path changes while the modal is open", () => {
    useCliAccountStore.setState({
      accounts: [
        account("acct-client", "Client work", "claude-code"),
        account("acct-oss", "OSS", "claude-code"),
      ],
      stickyDefaults: {
        [LOCAL_PATH]: { "claude-code": "acct-client" },
        [OTHER_PATH]: { "claude-code": "acct-oss" },
      },
    });
    mocks.workspaces = [
      { id: "ws-other", projectPath: OTHER_PATH, serverId: undefined },
    ];

    render(
      <WorkspaceCreationModal
        onClose={() => {}}
        initialSelected={new Set(["claude-code"])}
      />,
    );
    openAdvanced();
    expect(screen.getByText("Client work")).toBeInTheDocument();

    // Retarget the workspace at a different project via the recent-paths
    // dropdown, and the account must follow the NEW path's sticky default.
    fireEvent.click(screen.getAllByTitle(LOCAL_PATH)[0].closest("button")!);
    fireEvent.click(screen.getByText(OTHER_PATH).closest("button")!);

    expect(screen.getByText("OSS")).toBeInTheDocument();
    expect(screen.queryByText("Client work")).toBeNull();
  });

  it("passes only explicitly-switched slots to createWorkspace", () => {
    useCliAccountStore.setState({
      accounts: [
        account("acct-client", "Client work", "claude-code"),
        account("acct-personal", "Personal", "claude-code"),
      ],
      stickyDefaults: { [LOCAL_PATH]: { "claude-code": "acct-client" } },
    });

    render(
      <WorkspaceCreationModal
        onClose={() => {}}
        initialSelected={new Set(["claude-code"])}
      />,
    );
    openAdvanced();

    // Untouched: the modal sends an empty map and the store resolves the
    // sticky default itself — identical to the modal-free call sites.
    fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    expect(mocks.createWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      ["claude-code"],
      LOCAL_PATH,
      expect.objectContaining({ accountIds: {} }),
    );
  });

  it("sends the switched account as an explicit choice", () => {
    useCliAccountStore.setState({
      accounts: [
        account("acct-client", "Client work", "claude-code"),
        account("acct-personal", "Personal", "claude-code"),
      ],
      stickyDefaults: { [LOCAL_PATH]: { "claude-code": "acct-client" } },
    });

    render(
      <WorkspaceCreationModal
        onClose={() => {}}
        initialSelected={new Set(["claude-code"])}
      />,
    );
    openAdvanced();

    fireEvent.click(screen.getByText("Client work"));
    fireEvent.click(screen.getByRole("option", { name: /Personal/ }));
    fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));

    expect(mocks.createWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      ["claude-code"],
      LOCAL_PATH,
      expect.objectContaining({ accountIds: { "claude-code": "acct-personal" } }),
    );
  });
});
