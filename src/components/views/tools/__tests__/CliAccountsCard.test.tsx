/**
 * The Settings surface is the ONLY place a CLI account is created or removed,
 * so these tests pin that it can actually do both, that destruction goes
 * through the shared styled confirm (never the native dialog), and that the
 * form refuses to register the CLI's own default directory — a record on
 * `~/.claude` would shadow the ambient login instead of adding a second one.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveCliAccountsSlice = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/tauri", () => ({
  saveCliAccountsSlice: (...args: unknown[]) => saveCliAccountsSlice(...args),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn().mockResolvedValue("/home/me") }));
const openDialog = vi.fn().mockResolvedValue(null);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialog(...a) }));

import { CliAccountsCard } from "@/components/views/tools/CliAccountsCard";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import type { CliAccount } from "@/types/cliAccount";

const CLIENT: CliAccount = {
  id: "acct_1",
  label: "Client work",
  cli: "claude-code",
  configDir: "/home/me/.claude-client",
  email: "me@client.test",
  createdAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  saveCliAccountsSlice.mockResolvedValue(undefined);
  openDialog.mockResolvedValue(null);
  useCliAccountStore.setState({ accounts: [], stickyDefaults: {} });
});

/**
 * Render and flush the async `homeDir()` lookup, so every test starts from a
 * card that already knows the home dir (and React logs no act() warning for
 * the resolution landing mid-assertion).
 */
async function renderCard(props: Parameters<typeof CliAccountsCard>[0] = {}) {
  await act(async () => {
    render(<CliAccountsCard {...props} />);
  });
}

/** Wait for the async `homeDir()` resolution so the suggestion is populated. */
async function openAddForm() {
  fireEvent.click(screen.getByRole("button", { name: "Add CLI account" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Config directory")).toHaveValue("/home/me/.claude-account"),
  );
}

describe("CliAccountsCard rendering", () => {
  it("says the existing login keeps working when there are no accounts", async () => {
    await renderCard();
    expect(screen.getByText(/No CLI accounts yet/)).toBeInTheDocument();
  });

  it("lists label, CLI, config dir, email, and last used", async () => {
    useCliAccountStore.setState({ accounts: [CLIENT], stickyDefaults: {} });
    await renderCard();

    expect(screen.getByText("Client work")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("/home/me/.claude-client")).toBeInTheDocument();
    expect(screen.getByText("me@client.test")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
  });

  it("names the env var so the mechanism is not a mystery", async () => {
    await renderCard();
    expect(screen.getByText(/CLAUDE_CONFIG_DIR/)).toBeInTheDocument();
    expect(screen.getByText(/CODEX_HOME/)).toBeInTheDocument();
  });
});

describe("CliAccountsCard create", () => {
  it("suggests ~/.claude-<slug> from the label until the user overrides it", async () => {
    await renderCard();
    await openAddForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Client work" } });
    expect(screen.getByLabelText("Config directory")).toHaveValue("/home/me/.claude-client-work");

    fireEvent.change(screen.getByLabelText("CLI"), { target: { value: "codex" } });
    expect(screen.getByLabelText("Config directory")).toHaveValue("/home/me/.codex-client-work");

    fireEvent.change(screen.getByLabelText("Config directory"), {
      target: { value: "/opt/accounts/codex-a" },
    });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    // Once touched, the field stops following the label.
    expect(screen.getByLabelText("Config directory")).toHaveValue("/opt/accounts/codex-a");
  });

  it("creates the account and persists it", async () => {
    await renderCard();
    await openAddForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Client work" } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "me@client.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    const accounts = useCliAccountStore.getState().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      label: "Client work",
      cli: "claude-code",
      configDir: "/home/me/.claude-client-work",
      email: "me@client.test",
    });
    expect(saveCliAccountsSlice).toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Add CLI account" })).not.toBeInTheDocument();
  });

  it("stores the resolved path when the user types a ~ shorthand", async () => {
    await renderCard();
    await openAddForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Work" } });
    fireEvent.change(screen.getByLabelText("Config directory"), {
      target: { value: "~/.claude-typed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    // A literal `~` in a PTY env var would never expand, so it must not persist.
    expect(useCliAccountStore.getState().accounts[0].configDir).toBe("/home/me/.claude-typed");
  });

  it("uses the folder picker when the user browses", async () => {
    openDialog.mockResolvedValue("/opt/accounts/claude-picked");
    await renderCard();
    await openAddForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Picked" } });
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("Config directory")).toHaveValue("/opt/accounts/claude-picked"),
    );
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
  });
});

describe("CliAccountsCard validation", () => {
  it("refuses an empty label", async () => {
    await renderCard();
    await openAddForm();

    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    expect(useCliAccountStore.getState().accounts).toHaveLength(0);
    expect(screen.getByText(/Give the account a name/)).toBeInTheDocument();
  });

  it("refuses the CLI's DEFAULT directory, which IS the ambient login", async () => {
    await renderCard();
    await openAddForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Shadow" } });
    fireEvent.change(screen.getByLabelText("Config directory"), {
      target: { value: "~/.claude" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    expect(useCliAccountStore.getState().accounts).toHaveLength(0);
    expect(screen.getByText(/already the ambient login/)).toBeInTheDocument();
  });

  it("refuses ~/.codex for a codex account too", async () => {
    await renderCard();
    await openAddForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Shadow" } });
    fireEvent.change(screen.getByLabelText("CLI"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Config directory"), {
      target: { value: "/home/me/.codex" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    expect(useCliAccountStore.getState().accounts).toHaveLength(0);
    expect(screen.getByText(/already the ambient login/)).toBeInTheDocument();
  });

  it("refuses a relative path", async () => {
    await renderCard();
    await openAddForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rel" } });
    fireEvent.change(screen.getByLabelText("Config directory"), {
      target: { value: ".claude-rel" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    expect(useCliAccountStore.getState().accounts).toHaveLength(0);
    expect(screen.getByText(/must be an absolute path/)).toBeInTheDocument();
  });
});

describe("CliAccountsCard edit", () => {
  it("saves an edit back onto the same record", async () => {
    useCliAccountStore.setState({ accounts: [CLIENT], stickyDefaults: {} });
    await renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Edit Client work" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Client work"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Client work EU" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const accounts = useCliAccountStore.getState().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(CLIENT.id);
    expect(accounts[0].label).toBe("Client work EU");
    // The edited record does not collide with itself on its own directory.
    expect(accounts[0].configDir).toBe("/home/me/.claude-client");
  });
});

describe("CliAccountsCard delete", () => {
  beforeEach(() => {
    useCliAccountStore.setState({ accounts: [CLIENT], stickyDefaults: {} });
  });

  it("does not delete on the trash click — it opens a named confirm", async () => {
    await renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Delete Client work" }));

    expect(useCliAccountStore.getState().accounts).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Delete CLI account?" })).toBeInTheDocument();
    expect(screen.getByText(/Client work \(Claude Code\)/)).toBeInTheDocument();
  });

  it("promises the directory and login on disk survive", async () => {
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Delete Client work" }));

    expect(screen.getByText(/are left untouched on disk/)).toBeInTheDocument();
  });

  it("cancelling performs no mutation", async () => {
    await renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Delete Client work" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useCliAccountStore.getState().accounts).toEqual([CLIENT]);

    fireEvent.click(screen.getByRole("button", { name: "Delete Client work" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useCliAccountStore.getState().accounts).toEqual([CLIENT]);
  });

  it("deletes only after the explicit confirm button", async () => {
    await renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Delete Client work" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    expect(useCliAccountStore.getState().accounts).toEqual([]);
  });

  it("never reaches for the native dialog", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    await renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Delete Client work" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    expect(nativeConfirm).not.toHaveBeenCalled();
    nativeConfirm.mockRestore();
  });
});

describe("CliAccountsCard login seam", () => {
  beforeEach(() => {
    useCliAccountStore.setState({ accounts: [CLIENT], stickyDefaults: {} });
  });

  it("hands the account to onRequestLogin and does nothing else", async () => {
    const onRequestLogin = vi.fn();
    await renderCard({ onRequestLogin });

    fireEvent.click(screen.getByRole("button", { name: "Log in to Client work" }));

    expect(onRequestLogin).toHaveBeenCalledWith(CLIENT);
    // The card owns the record, not the login: no persistence side effect.
    expect(saveCliAccountsSlice).not.toHaveBeenCalled();
  });

  it("renders the button disabled until the flow is wired", async () => {
    await renderCard();
    expect(screen.getByRole("button", { name: "Log in to Client work" })).toBeDisabled();
  });
});
