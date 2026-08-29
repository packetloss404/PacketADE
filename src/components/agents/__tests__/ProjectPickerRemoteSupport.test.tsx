import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPicker } from "@/components/agents/composer/ProjectPicker";
import { makeSshUri } from "@/lib/ssh-uri";
import type { ServerConfig } from "@/types/server";

const mocks = vi.hoisted(() => ({
  setActiveView: vi.fn(),
  updateServer: vi.fn(),
  recordOpen: vi.fn(),
  openDialog: vi.fn(),
  servers: [] as ServerConfig[],
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mocks.openDialog(...args),
}));

vi.mock("@/stores/agentTaskStore", () => ({
  repoDisplayName: (path: string) => path.split(/[\\/]/).pop() ?? path,
}));

vi.mock("@/stores/githubStore", () => ({
  useGitHubStore: vi.fn((selector: (state: { repos: unknown[] }) => unknown) =>
    selector({ repos: [] }),
  ),
}));

vi.mock("@/stores/projectHistoryStore", () => ({
  useProjectHistoryStore: vi.fn(
    (
      selector: (state: {
        projects: Array<{ path: string; lastOpened: number }>;
        recordOpen: (path: string) => void;
      }) => unknown,
    ) =>
      selector({
        projects: [],
        recordOpen: mocks.recordOpen,
      }),
  ),
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: vi.fn(
    (
      selector: (state: {
        servers: ServerConfig[];
        updateServer: (id: string, updates: Partial<ServerConfig>) => void;
      }) => unknown,
    ) =>
      selector({
        servers: mocks.servers,
        updateServer: mocks.updateServer,
      }),
  ),
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: vi.fn((selector: (state: { setActiveView: (view: string) => void }) => unknown) =>
    selector({ setActiveView: mocks.setActiveView }),
  ),
}));

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "server-1",
    name: "Build host",
    host: "example.com",
    port: 2222,
    username: "ian",
    authMethod: "key",
    keyPath: "/home/ian/.ssh/id_ed25519",
    remotePath: "/srv/app",
    installedAgents: [],
    lastConnectedAt: 10,
    hostFingerprint: "SHA256:test",
    ...overrides,
  };
}

function openProjectDropdown() {
  fireEvent.click(screen.getByRole("button", { name: /select a project/i }));
}

describe("ProjectPicker remote support display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.servers = [server()];
  });

  it("selects an SSH target without provider-level remote gating", () => {
    const setSelectedRepo = vi.fn();
    render(<ProjectPicker selectedRepo={null} setSelectedRepo={setSelectedRepo} />);

    openProjectDropdown();
    fireEvent.click(screen.getByText("Build host"));

    expect(screen.queryByTitle(/don't support remote SSH/i)).not.toBeInTheDocument();
    expect(setSelectedRepo).toHaveBeenCalledWith(makeSshUri("server-1", "/srv/app"));
    expect(mocks.updateServer).toHaveBeenCalledWith(
      "server-1",
      expect.objectContaining({ lastConnectedAt: expect.any(Number) }),
    );
  });

  it("renders the selected remote host and lets the user edit the per-session path", () => {
    const setSelectedRepo = vi.fn();
    render(
      <ProjectPicker
        selectedRepo={makeSshUri("server-1", "/srv/app")}
        setSelectedRepo={setSelectedRepo}
      />,
    );

    expect(screen.getByText(/ian@example\.com:2222/)).toBeInTheDocument();
    const input = screen.getByPlaceholderText("/home/user/project");
    expect(input).toHaveValue("/srv/app");

    fireEvent.change(input, { target: { value: "/srv/other app" } });

    expect(setSelectedRepo).toHaveBeenCalledWith(makeSshUri("server-1", "/srv/other app"));
  });
});

describe("ProjectPicker host-key disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * FAULT: an unpinned SSH host silently falls back to TOFU
   * (`StrictHostKeyChecking=accept-new`) on the interactive path. The only
   * signals were a `console.warn` and a Rust `tracing::warn!` — neither
   * reaches the person choosing to connect.
   */
  it("says the host key is unverified at the point of connect", () => {
    mocks.servers = [server({ hostFingerprint: undefined })];
    render(
      <ProjectPicker
        selectedRepo={makeSshUri("server-1", "/srv/app")}
        setSelectedRepo={vi.fn()}
      />,
    );

    expect(screen.getByText(/Host key not verified/i)).toBeInTheDocument();
    // Names the host that is about to be trusted on sight, not a generic note.
    expect(screen.getByText(/example\.com presents on first connect/i)).toBeInTheDocument();
    // ...and offers the fix rather than just the complaint.
    fireEvent.click(screen.getByRole("button", { name: "Open Servers" }));
    expect(mocks.setActiveView).toHaveBeenCalledWith("tools");
  });

  it("stays quiet when the host key IS pinned", () => {
    // The warning has to be a real signal, so it must not fire on the
    // pinned path — otherwise it becomes wallpaper.
    mocks.servers = [server({ hostFingerprint: "SHA256:pinned" })];
    render(
      <ProjectPicker
        selectedRepo={makeSshUri("server-1", "/srv/app")}
        setSelectedRepo={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Host key not verified/i)).not.toBeInTheDocument();
  });

  it("flags an unpinned server in the picker before it is chosen", () => {
    mocks.servers = [server({ hostFingerprint: undefined })];
    render(<ProjectPicker selectedRepo={null} setSelectedRepo={vi.fn()} />);

    openProjectDropdown();
    expect(screen.getByText("unverified host key")).toBeInTheDocument();
  });

  it("does not flag a pinned server in the picker", () => {
    mocks.servers = [server({ hostFingerprint: "SHA256:pinned" })];
    render(<ProjectPicker selectedRepo={null} setSelectedRepo={vi.fn()} />);

    openProjectDropdown();
    expect(screen.queryByText("unverified host key")).not.toBeInTheDocument();
  });
});
