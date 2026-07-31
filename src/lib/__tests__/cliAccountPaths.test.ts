import { describe, expect, it } from "vitest";
import {
  defaultConfigDirFor,
  expandHome,
  isAbsolutePath,
  samePath,
  slugifyAccountLabel,
  suggestConfigDir,
  validateCliAccount,
} from "@/lib/cliAccountPaths";
import type { CliAccount } from "@/types/cliAccount";

const HOME = "/home/me";

const EXISTING: CliAccount = {
  id: "acct_1",
  label: "Client work",
  cli: "claude-code",
  configDir: "/home/me/.claude-client",
  createdAt: 1,
};

describe("path helpers", () => {
  it("slugifies labels into directory-safe suffixes", () => {
    expect(slugifyAccountLabel("Client work (EU)")).toBe("client-work-eu");
    expect(slugifyAccountLabel("  Personal / OSS  ")).toBe("personal-oss");
    expect(slugifyAccountLabel("!!!")).toBe("");
  });

  it("suggests ~/.claude-<slug> and ~/.codex-<slug>", () => {
    expect(suggestConfigDir("claude-code", "Client work", HOME)).toBe(
      "/home/me/.claude-client-work",
    );
    expect(suggestConfigDir("codex", "OSS", HOME)).toBe("/home/me/.codex-oss");
    expect(suggestConfigDir("codex", "!!!", HOME)).toBe("/home/me/.codex-account");
  });

  it("suggests Windows paths with backslashes", () => {
    expect(suggestConfigDir("claude-code", "Work", "C:\\Users\\me")).toBe(
      "C:\\Users\\me\\.claude-work",
    );
  });

  it("names the ambient default dir per CLI", () => {
    expect(defaultConfigDirFor("claude-code", HOME)).toBe("/home/me/.claude");
    expect(defaultConfigDirFor("codex", HOME)).toBe("/home/me/.codex");
  });

  it("expands a leading ~ only", () => {
    expect(expandHome("~/.claude-work", HOME)).toBe("/home/me/.claude-work");
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("/absolute/path", HOME)).toBe("/absolute/path");
    // A `~` inside the path is a legitimate directory name, not a home ref.
    expect(expandHome("/opt/~backup", HOME)).toBe("/opt/~backup");
  });

  it("recognises POSIX, Windows, and UNC absolute paths", () => {
    expect(isAbsolutePath("/home/me/.claude-work")).toBe(true);
    expect(isAbsolutePath("C:\\Users\\me\\.claude-work")).toBe(true);
    expect(isAbsolutePath("c:/Users/me")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath(".claude-work")).toBe(false);
    expect(isAbsolutePath("./relative")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });

  it("compares paths the way the filesystem does", () => {
    expect(samePath("/home/me/.claude", "/home/me/.claude/")).toBe(true);
    expect(samePath("C:\\Users\\Me\\.claude", "c:/users/me/.claude")).toBe(true);
    // POSIX is case-sensitive; do not over-normalize.
    expect(samePath("/home/me/.Claude", "/home/me/.claude")).toBe(false);
  });
});

describe("validateCliAccount", () => {
  function validate(overrides: Partial<Parameters<typeof validateCliAccount>[0]> = {}) {
    return validateCliAccount({
      label: "Work",
      cli: "claude-code",
      configDir: "/home/me/.claude-work",
      home: HOME,
      accounts: [],
      ...overrides,
    });
  }

  it("accepts a well-formed account", () => {
    expect(validate().errors).toEqual({});
  });

  it("requires a non-empty label", () => {
    expect(validate({ label: "   " }).errors.label).toBeTruthy();
  });

  it("requires an absolute config directory", () => {
    expect(validate({ configDir: ".claude-work" }).errors.configDir).toMatch(/absolute/);
    expect(validate({ configDir: "" }).errors.configDir).toBeTruthy();
  });

  it("resolves ~ before validating and reports the resolved path", () => {
    const result = validate({ configDir: "~/.claude-work" });
    expect(result.errors).toEqual({});
    expect(result.resolvedConfigDir).toBe("/home/me/.claude-work");
  });

  it("rejects the CLI's DEFAULT directory — that is the ambient login", () => {
    // Registering ~/.claude as an account would give one login two names and
    // make "no account selected" ambiguous.
    expect(validate({ configDir: "/home/me/.claude" }).errors.configDir).toMatch(/default/i);
    expect(validate({ configDir: "~/.claude" }).errors.configDir).toMatch(/default/i);
    expect(validate({ configDir: "/home/me/.claude/" }).errors.configDir).toMatch(/default/i);
    expect(
      validate({ cli: "codex", configDir: "/home/me/.codex" }).errors.configDir,
    ).toMatch(/default/i);
  });

  it("rejects the default dir case-insensitively on Windows paths", () => {
    expect(
      validate({ home: "C:\\Users\\me", configDir: "c:/users/me/.CLAUDE" }).errors.configDir,
    ).toMatch(/default/i);
  });

  it("allows the OTHER CLI's default dir name — only the matching one is ambient", () => {
    expect(validate({ cli: "codex", configDir: "/home/me/.claude" }).errors).toEqual({});
  });

  it("rejects a directory another account of the same CLI already uses", () => {
    expect(
      validate({ accounts: [EXISTING], configDir: "/home/me/.claude-client" }).errors.configDir,
    ).toMatch(/already uses/);
  });

  it("lets an account keep its own directory while editing", () => {
    expect(
      validate({
        accounts: [EXISTING],
        configDir: "/home/me/.claude-client",
        editingId: EXISTING.id,
      }).errors,
    ).toEqual({});
  });

  it("allows the same directory for a different CLI", () => {
    expect(
      validate({ accounts: [EXISTING], cli: "codex", configDir: "/home/me/.claude-client" })
        .errors,
    ).toEqual({});
  });

  it("still validates absoluteness when the home dir is unknown", () => {
    expect(validate({ home: "", configDir: "relative" }).errors.configDir).toMatch(/absolute/);
    expect(validate({ home: "", configDir: "/home/me/.claude" }).errors).toEqual({});
  });
});
