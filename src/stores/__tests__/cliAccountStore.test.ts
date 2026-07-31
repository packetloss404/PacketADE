/**
 * The store is the only writer of the CLI-account slice, so these tests pin
 * the two things the rest of the feature trusts blindly:
 *   - CRUD round-trips and every mutation reaches the backend in ONE call
 *     carrying both accounts and defaults;
 *   - a sticky default never survives the account it names — a dangling id
 *     would resolve to "no account" and silently launch a session under the
 *     ambient login, which is the exact cross-account leak this feature exists
 *     to prevent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveCliAccountsSlice = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/tauri", () => ({
  saveCliAccountsSlice: (...args: unknown[]) => saveCliAccountsSlice(...args),
}));

import { useCliAccountStore } from "@/stores/cliAccountStore";
import type { CliAccount } from "@/types/cliAccount";

function reset() {
  useCliAccountStore.setState({ accounts: [], stickyDefaults: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  saveCliAccountsSlice.mockResolvedValue(undefined);
  reset();
});

describe("cliAccountStore CRUD", () => {
  it("adds an account with a generated id and creation stamp", () => {
    const account = useCliAccountStore.getState().addAccount({
      label: "Client work",
      cli: "claude-code",
      configDir: "/home/me/.claude-client",
    });

    expect(account.id).toMatch(/^acct_/);
    expect(account.createdAt).toBeGreaterThan(0);
    expect(useCliAccountStore.getState().accounts).toEqual([account]);
  });

  it("persists the whole slice on every mutation", () => {
    const account = useCliAccountStore.getState().addAccount({
      label: "OSS",
      cli: "codex",
      configDir: "/home/me/.codex-oss",
    });

    expect(saveCliAccountsSlice).toHaveBeenCalledTimes(1);
    expect(saveCliAccountsSlice).toHaveBeenLastCalledWith([account], {});

    useCliAccountStore.getState().updateAccount(account.id, { label: "OSS work" });
    expect(saveCliAccountsSlice).toHaveBeenCalledTimes(2);
    expect(saveCliAccountsSlice.mock.calls[1][0]).toEqual([{ ...account, label: "OSS work" }]);
  });

  it("refuses to let a patch rewrite identity fields", () => {
    const account = useCliAccountStore.getState().addAccount({
      label: "OSS",
      cli: "codex",
      configDir: "/home/me/.codex-oss",
    });

    useCliAccountStore
      .getState()
      .updateAccount(account.id, { id: "spoofed", createdAt: 1 } as Partial<CliAccount>);

    const stored = useCliAccountStore.getState().accounts[0];
    expect(stored.id).toBe(account.id);
    expect(stored.createdAt).toBe(account.createdAt);
  });

  it("looks accounts up by id and filters them by CLI", () => {
    const claude = useCliAccountStore
      .getState()
      .addAccount({ label: "A", cli: "claude-code", configDir: "/h/.claude-a" });
    const codex = useCliAccountStore
      .getState()
      .addAccount({ label: "B", cli: "codex", configDir: "/h/.codex-b" });

    const state = useCliAccountStore.getState();
    expect(state.getAccount(claude.id)).toEqual(claude);
    expect(state.getAccount(null)).toBeUndefined();
    expect(state.getAccount(undefined)).toBeUndefined();
    expect(state.getAccount("nope")).toBeUndefined();
    expect(state.accountsForCli("claude-code")).toEqual([claude]);
    expect(state.accountsForCli("codex")).toEqual([codex]);
  });

  it("deletes the record only", () => {
    const account = useCliAccountStore
      .getState()
      .addAccount({ label: "A", cli: "claude-code", configDir: "/h/.claude-a" });

    useCliAccountStore.getState().deleteAccount(account.id);

    expect(useCliAccountStore.getState().accounts).toEqual([]);
    expect(saveCliAccountsSlice).toHaveBeenLastCalledWith([], {});
  });

  it("stamps lastUsedAt, and ignores an unknown id", () => {
    const account = useCliAccountStore
      .getState()
      .addAccount({ label: "A", cli: "claude-code", configDir: "/h/.claude-a" });
    expect(account.lastUsedAt).toBeUndefined();

    useCliAccountStore.getState().markUsed(account.id);
    expect(useCliAccountStore.getState().accounts[0].lastUsedAt).toBeGreaterThan(0);

    const callsBefore = saveCliAccountsSlice.mock.calls.length;
    useCliAccountStore.getState().markUsed("ghost");
    expect(saveCliAccountsSlice.mock.calls.length).toBe(callsBefore);
  });

  it("hydrates from the backend", () => {
    const account: CliAccount = {
      id: "acct_1",
      label: "Restored",
      cli: "codex",
      configDir: "/h/.codex-restored",
      createdAt: 5,
    };
    useCliAccountStore
      .getState()
      .hydrateFromBackend([account], { "/proj": { codex: "acct_1" } });

    expect(useCliAccountStore.getState().accounts).toEqual([account]);
    expect(useCliAccountStore.getState().defaultFor("/proj", "codex")).toBe("acct_1");
  });
});

describe("cliAccountStore sticky defaults", () => {
  it("has no default until one is remembered", () => {
    expect(useCliAccountStore.getState().defaultFor("/proj", "claude-code")).toBeNull();
  });

  it("remembers a default per project AND per CLI", () => {
    const claude = useCliAccountStore
      .getState()
      .addAccount({ label: "A", cli: "claude-code", configDir: "/h/.claude-a" });
    const codex = useCliAccountStore
      .getState()
      .addAccount({ label: "B", cli: "codex", configDir: "/h/.codex-b" });

    useCliAccountStore.getState().rememberDefault("/proj", "claude-code", claude.id);
    useCliAccountStore.getState().rememberDefault("/proj", "codex", codex.id);
    useCliAccountStore.getState().rememberDefault("/other", "claude-code", claude.id);

    const state = useCliAccountStore.getState();
    expect(state.defaultFor("/proj", "claude-code")).toBe(claude.id);
    expect(state.defaultFor("/proj", "codex")).toBe(codex.id);
    expect(state.defaultFor("/other", "claude-code")).toBe(claude.id);
    expect(state.defaultFor("/other", "codex")).toBeNull();
  });

  it("clears the default when the user picks the ambient login", () => {
    const account = useCliAccountStore
      .getState()
      .addAccount({ label: "A", cli: "claude-code", configDir: "/h/.claude-a" });
    useCliAccountStore.getState().rememberDefault("/proj", "claude-code", account.id);

    useCliAccountStore.getState().rememberDefault("/proj", "claude-code", null);

    expect(useCliAccountStore.getState().defaultFor("/proj", "claude-code")).toBeNull();
    // The project entry is dropped rather than left as an empty husk.
    expect(useCliAccountStore.getState().stickyDefaults).toEqual({});
  });

  it("prunes defaults pointing at a deleted account, keeping the others", () => {
    const claude = useCliAccountStore
      .getState()
      .addAccount({ label: "A", cli: "claude-code", configDir: "/h/.claude-a" });
    const codex = useCliAccountStore
      .getState()
      .addAccount({ label: "B", cli: "codex", configDir: "/h/.codex-b" });
    useCliAccountStore.getState().rememberDefault("/proj", "claude-code", claude.id);
    useCliAccountStore.getState().rememberDefault("/proj", "codex", codex.id);
    useCliAccountStore.getState().rememberDefault("/other", "claude-code", claude.id);

    useCliAccountStore.getState().deleteAccount(claude.id);

    const state = useCliAccountStore.getState();
    expect(state.defaultFor("/proj", "claude-code")).toBeNull();
    expect(state.defaultFor("/proj", "codex")).toBe(codex.id);
    // `/other` only pointed at the deleted account, so it is gone entirely.
    expect(state.stickyDefaults).toEqual({ "/proj": { codex: codex.id } });
    // The pruned map is what got persisted, not the stale one.
    expect(saveCliAccountsSlice).toHaveBeenLastCalledWith([codex], {
      "/proj": { codex: codex.id },
    });
  });

  it("resolves a dangling default to null rather than a phantom id", () => {
    // Simulates a state file whose accounts and defaults disagree.
    useCliAccountStore.setState({
      accounts: [],
      stickyDefaults: { "/proj": { "claude-code": "acct_gone" } },
    });

    expect(useCliAccountStore.getState().defaultFor("/proj", "claude-code")).toBeNull();
  });

  it("logs rather than throwing when the backend write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    saveCliAccountsSlice.mockRejectedValueOnce(new Error("disk full"));

    useCliAccountStore
      .getState()
      .addAccount({ label: "A", cli: "claude-code", configDir: "/h/.claude-a" });

    expect(useCliAccountStore.getState().accounts).toHaveLength(1);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("cliAccountStore.save"),
        expect.anything(),
      ),
    );
    warn.mockRestore();
  });
});
