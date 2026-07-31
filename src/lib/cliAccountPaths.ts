/**
 * Path suggestion + validation for CLI accounts.
 *
 * Kept out of the Settings card so the rules are testable on their own and so
 * any future launch-time re-check applies the SAME rules the form enforced.
 */
import { CLI_ACCOUNT_DEFAULT_DIR_NAME } from "@/types/cliAccount";
import type { CliAccount, CliAccountCli } from "@/types/cliAccount";

/** `"Client work (EU)"` → `"client-work-eu"`. Empty when nothing survives. */
export function slugifyAccountLabel(label: string): string {
  return label
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function joinHome(home: string, child: string): string {
  const trimmed = home.replace(/[\\/]+$/, "");
  const sep = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  return `${trimmed}${sep}${child}`;
}

/** The dir the CLI uses when no account is selected: `~/.claude` / `~/.codex`. */
export function defaultConfigDirFor(cli: CliAccountCli, home: string): string {
  return joinHome(home, CLI_ACCOUNT_DEFAULT_DIR_NAME[cli]);
}

/**
 * Suggested directory for a new account: `~/.claude-<slug>` / `~/.codex-<slug>`.
 * Falls back to a timestamp-free generic suffix when the label slugifies to
 * nothing (e.g. a label of only punctuation), which validation then rejects
 * only if it collides — never silently equal to the default dir.
 */
export function suggestConfigDir(cli: CliAccountCli, label: string, home: string): string {
  const slug = slugifyAccountLabel(label) || "account";
  return joinHome(home, `${CLI_ACCOUNT_DEFAULT_DIR_NAME[cli]}-${slug}`);
}

/**
 * Expand a leading `~` and strip trailing separators. Everything else is left
 * alone — we deliberately do not resolve `..` or symlinks here; that is the
 * OS's job at spawn time, and guessing would create a false sense of safety.
 */
export function expandHome(path: string, home: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return joinHome(home, trimmed.slice(2));
  }
  return trimmed;
}

/** POSIX `/…`, Windows `C:\…` / `C:/…`, or a UNC `\\server\share`. */
export function isAbsolutePath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith("\\\\")) return true;
  return false;
}

/**
 * Compare two paths for "is this the same directory". Separators are unified
 * and trailing ones dropped; Windows-style paths compare case-insensitively
 * because the filesystem does.
 */
export function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const unified = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const isWindowsish = /^[a-zA-Z]:\//.test(unified) || p.trim().startsWith("\\\\");
    return isWindowsish ? unified.toLocaleLowerCase() : unified;
  };
  return normalize(a) === normalize(b);
}

export interface CliAccountValidationInput {
  label: string;
  cli: CliAccountCli;
  configDir: string;
  /** Resolved home dir; `""` disables the default-dir and `~` checks. */
  home: string;
  /** Existing records, for collision checks. */
  accounts: CliAccount[];
  /** Set when editing, so a record does not collide with itself. */
  editingId?: string | null;
}

export interface CliAccountValidationResult {
  /** Field-keyed messages. Empty object ⇒ valid. */
  errors: Partial<Record<"label" | "configDir", string>>;
  /** `configDir` with `~` expanded and trailing separators stripped. */
  resolvedConfigDir: string;
}

/**
 * The rules:
 *   - label must be non-empty;
 *   - configDir must be absolute (after `~` expansion);
 *   - configDir must NOT be the CLI's default dir — that IS the ambient
 *     login, and shadowing it with a record would give one login two names
 *     and make "no account selected" ambiguous;
 *   - configDir must not already belong to another account of the same CLI,
 *     because two records on one directory are two names for one login.
 */
export function validateCliAccount(
  input: CliAccountValidationInput,
): CliAccountValidationResult {
  const errors: CliAccountValidationResult["errors"] = {};
  const resolvedConfigDir = input.home
    ? expandHome(input.configDir, input.home)
    : input.configDir.trim();

  if (!input.label.trim()) {
    errors.label = "Give the account a name so you can tell it apart at launch time.";
  }

  if (!resolvedConfigDir) {
    errors.configDir = "Choose a config directory for this account.";
  } else if (!isAbsolutePath(resolvedConfigDir)) {
    errors.configDir = "The config directory must be an absolute path.";
  } else if (input.home && samePath(resolvedConfigDir, defaultConfigDirFor(input.cli, input.home))) {
    errors.configDir =
      "That is the CLI's default directory — it is already the ambient login. " +
      "Pick a separate directory, e.g. ~/.claude-work.";
  } else {
    const clash = input.accounts.find(
      (account) =>
        account.id !== input.editingId &&
        account.cli === input.cli &&
        samePath(account.configDir, resolvedConfigDir),
    );
    if (clash) {
      errors.configDir = `“${clash.label}” already uses that directory.`;
    }
  }

  return { errors, resolvedConfigDir };
}
