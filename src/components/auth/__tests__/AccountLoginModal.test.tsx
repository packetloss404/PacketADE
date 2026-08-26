/**
 * The login flow is what makes a SECOND account reachable at all: without the
 * account's own `CLAUDE_CONFIG_DIR` / `CODEX_HOME` on the `claude login` /
 * `codex login` PTY, credentials land in the ambient dir and the launch gate
 * blocks that account forever.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliAccount } from "@/types/cliAccount";

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(async () => "/home/ian"),
}));

const seedCliAccountConfigDir = vi.fn();
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    seedCliAccountConfigDir: (...args: unknown[]) => seedCliAccountConfigDir(...args),
  };
});

// Stand in for the xterm-backed modal and capture the spawn parameters.
interface CapturedPty {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  title: string;
}
const capture: { current: CapturedPty | null } = { current: null };

/** Read through a function boundary so control-flow analysis doesn't narrow
 *  `capture.current` to the `null` each test resets it to. */
function lastPty(): CapturedPty {
  if (!capture.current) throw new Error("TransientPtyModal was never rendered");
  return capture.current;
}

vi.mock("@/components/ui/TransientPtyModal", () => ({
  TransientPtyModal: (props: CapturedPty) => {
    capture.current = props;
    return <div data-testid="transient-pty-modal">{props.title}</div>;
  },
}));

import { AccountLoginModal } from "@/components/auth/AccountLoginModal";
import { LoginPtyModal } from "@/components/auth/LoginPtyModal";

const CLAUDE_ACCOUNT: CliAccount = {
  id: "acct-client",
  label: "Client work",
  cli: "claude-code",
  configDir: "/srv/accts/client",
  createdAt: 1,
};

const CODEX_ACCOUNT: CliAccount = {
  id: "acct-codex",
  label: "Codex personal",
  cli: "codex",
  configDir: "/srv/accts/codex",
  createdAt: 2,
};

describe("AccountLoginModal", () => {
  beforeEach(() => {
    capture.current = null;
    seedCliAccountConfigDir.mockReset();
    seedCliAccountConfigDir.mockResolvedValue({
      createdDir: true,
      copied: ["settings.json"],
      skippedExisting: [],
    });
  });

  it("runs `claude login` with the account's CLAUDE_CONFIG_DIR", async () => {
    render(<AccountLoginModal account={CLAUDE_ACCOUNT} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("transient-pty-modal")).toBeInTheDocument());
    expect(lastPty().command).toBe("claude");
    expect(lastPty().args).toEqual(["login"]);
    expect(lastPty().env).toEqual({ CLAUDE_CONFIG_DIR: "/srv/accts/client" });
  });

  it("runs `codex login` with the account's CODEX_HOME", async () => {
    render(<AccountLoginModal account={CODEX_ACCOUNT} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("transient-pty-modal")).toBeInTheDocument());
    expect(lastPty().command).toBe("codex");
    expect(lastPty().env).toEqual({ CODEX_HOME: "/srv/accts/codex" });
  });

  it("names the account in the dialog title so the user knows which login they are completing", async () => {
    render(<AccountLoginModal account={CLAUDE_ACCOUNT} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("transient-pty-modal")).toHaveTextContent("Client work"),
    );
  });

  // Without this the new account starts with no statusline hook and none of
  // the MCP servers PacketBench writes into the ambient settings.json.
  it("seeds the account config dir from the ambient dir BEFORE starting the login PTY", async () => {
    let resolveSeed: (v: unknown) => void = () => {};
    seedCliAccountConfigDir.mockReturnValue(
      new Promise((r) => {
        resolveSeed = r;
      }),
    );
    render(<AccountLoginModal account={CLAUDE_ACCOUNT} onClose={vi.fn()} />);

    // The CLI reads its settings at startup, so the PTY must not exist yet.
    expect(screen.queryByTestId("transient-pty-modal")).not.toBeInTheDocument();

    await waitFor(() => expect(seedCliAccountConfigDir).toHaveBeenCalled());
    expect(seedCliAccountConfigDir).toHaveBeenCalledWith(
      "/home/ian/.claude",
      "/srv/accts/client",
    );

    resolveSeed({ createdDir: true, copied: [], skippedExisting: [] });
    await waitFor(() => expect(screen.getByTestId("transient-pty-modal")).toBeInTheDocument());
  });

  it("uses the codex ambient dir for a codex account", async () => {
    render(<AccountLoginModal account={CODEX_ACCOUNT} onClose={vi.fn()} />);
    await waitFor(() => expect(seedCliAccountConfigDir).toHaveBeenCalled());
    expect(seedCliAccountConfigDir).toHaveBeenCalledWith("/home/ian/.codex", "/srv/accts/codex");
  });

  it("still opens the login when seeding fails — degraded config, never blocked access", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedCliAccountConfigDir.mockRejectedValue(new Error("permission denied"));
    render(<AccountLoginModal account={CLAUDE_ACCOUNT} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("transient-pty-modal")).toBeInTheDocument());
    expect(lastPty().env).toEqual({ CLAUDE_CONFIG_DIR: "/srv/accts/client" });
    warn.mockRestore();
  });
});

describe("LoginPtyModal (ambient)", () => {
  it("passes no env, preserving the pre-multi-account sign-in flow", () => {
    capture.current = null;
    render(<LoginPtyModal cli="claude" onClose={vi.fn()} />);
    expect(lastPty().env).toBeUndefined();
    expect(lastPty().title).toBe("Sign in to Claude Code");
  });
});
