/**
 * Env derivation is the entire multi-account mechanism, so both directions
 * matter: the right variable for each CLI, and a genuine `{}` for the null
 * case so that "no account" stays byte-identical to pre-feature behaviour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  saveCliAccountsSlice: vi.fn().mockResolvedValue(undefined),
}));

import { accountEnvForSlot, cliAccountEnv } from "@/lib/cliAccountEnv";
import { useCliAccountStore } from "@/stores/cliAccountStore";
import type { CliAccount } from "@/types/cliAccount";

const CLAUDE: CliAccount = {
  id: "acct_claude",
  label: "Client work",
  cli: "claude-code",
  configDir: "/home/me/.claude-client",
  createdAt: 1,
};

const CODEX: CliAccount = {
  id: "acct_codex",
  label: "OSS",
  cli: "codex",
  configDir: "/home/me/.codex-oss",
  createdAt: 2,
};

beforeEach(() => {
  useCliAccountStore.setState({ accounts: [CLAUDE, CODEX], stickyDefaults: {} });
});

describe("cliAccountEnv", () => {
  it("relocates claude-code via CLAUDE_CONFIG_DIR", () => {
    expect(cliAccountEnv(CLAUDE)).toEqual({ CLAUDE_CONFIG_DIR: "/home/me/.claude-client" });
  });

  it("relocates codex via CODEX_HOME", () => {
    expect(cliAccountEnv(CODEX)).toEqual({ CODEX_HOME: "/home/me/.codex-oss" });
  });

  it("returns {} for the null case so the ambient login is used", () => {
    // Not `{ CLAUDE_CONFIG_DIR: "" }` — an empty var would point the CLI at a
    // relative path rather than leaving it on its default.
    expect(cliAccountEnv(null)).toEqual({});
    expect(cliAccountEnv(undefined)).toEqual({});
  });

  it("returns {} for a record with an unknown cli or empty dir", () => {
    expect(cliAccountEnv({ ...CLAUDE, cli: "gemini" as CliAccount["cli"] })).toEqual({});
    expect(cliAccountEnv({ ...CLAUDE, configDir: "" })).toEqual({});
  });
});

describe("accountEnvForSlot", () => {
  it("resolves the id through the store for each CLI slot", () => {
    expect(accountEnvForSlot("claude-code", CLAUDE.id)).toEqual({
      CLAUDE_CONFIG_DIR: "/home/me/.claude-client",
    });
    expect(accountEnvForSlot("codex", CODEX.id)).toEqual({
      CODEX_HOME: "/home/me/.codex-oss",
    });
  });

  it("returns {} when no account is selected", () => {
    expect(accountEnvForSlot("claude-code", null)).toEqual({});
    expect(accountEnvForSlot("claude-code", undefined)).toEqual({});
    expect(accountEnvForSlot("claude-code", "")).toEqual({});
  });

  it("returns {} for slots that have no account concept", () => {
    expect(accountEnvForSlot("terminal", CLAUDE.id)).toEqual({});
    expect(accountEnvForSlot("opencode", CLAUDE.id)).toEqual({});
    expect(accountEnvForSlot("packetcode", CLAUDE.id)).toEqual({});
  });

  it("returns {} for an id that no longer resolves", () => {
    expect(accountEnvForSlot("claude-code", "acct_deleted")).toEqual({});
  });

  it("refuses to cross the CLIs", () => {
    // A codex account's CODEX_HOME means nothing to the claude binary, so
    // emitting it would be a silent no-op that looks like it worked.
    expect(accountEnvForSlot("claude-code", CODEX.id)).toEqual({});
    expect(accountEnvForSlot("codex", CLAUDE.id)).toEqual({});
  });
});
