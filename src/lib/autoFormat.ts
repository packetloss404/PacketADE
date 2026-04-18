/**
 * Auto-format-on-accept helper.
 *
 * Picks a formatter based on the file extension and runs it as a
 * subprocess via the Tauri shell plugin. The function is intentionally
 * forgiving: if no formatter matches, or the binary is not installed,
 * it resolves with `{ ok: true }` and lets the caller continue.
 *
 * Real failures (non-zero exit with stderr from a formatter that *did*
 * run) surface as `{ ok: false, error }` so the caller can show a toast
 * or inline message.
 *
 * Usage:
 *   const result = await autoFormatFile(absolutePath, projectPath);
 *   if (!result.ok) toast.error(`${result.formatter}: ${result.error}`);
 */
import { Command } from "@tauri-apps/plugin-shell";

export interface AutoFormatResult {
  ok: boolean;
  formatter?: string;
  error?: string;
}

/** File extensions handled by Prettier. */
const PRETTIER_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "md",
  "html",
  "css",
  "yml",
  "yaml",
]);

/**
 * Lowercase extension without the leading dot, or `""` if none.
 * Handles Windows back-slashes by treating both separators as path
 * boundaries.
 */
function extOf(absolutePath: string): string {
  const lastSlash = Math.max(
    absolutePath.lastIndexOf("/"),
    absolutePath.lastIndexOf("\\"),
  );
  const base = absolutePath.slice(lastSlash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Heuristic: did the OS / shell tell us the program is missing?
 * Covers POSIX (`exit 127`) and the variety of "not found"/"not
 * recognized" messages emitted by Windows + Unix shells.
 */
function isMissingBinary(code: number | null, stderr: string): boolean {
  if (code === 127) return true;
  const lower = stderr.toLowerCase();
  return (
    lower.includes("command not found") ||
    lower.includes("not recognized as an internal or external command") ||
    lower.includes("is not recognized") ||
    lower.includes("no such file or directory") ||
    lower.includes("cannot find the path")
  );
}

/**
 * Run a single formatter command and translate the child output into an
 * `AutoFormatResult`. Catches synchronous spawn failures (e.g. the host
 * couldn't even locate the program to launch it) and treats them the
 * same as a missing binary so the caller can move on quietly.
 */
async function runFormatter(
  name: string,
  program: string,
  args: string[],
  cwd: string,
): Promise<AutoFormatResult> {
  try {
    const cmd = Command.create(program, args, { cwd });
    const child = await cmd.execute();
    const stderr = (child.stderr || "").toString();
    if (child.code === 0) {
      return { ok: true, formatter: name };
    }
    if (isMissingBinary(child.code, stderr)) {
      return { ok: true, formatter: `${name} (skipped: not installed)` };
    }
    return {
      ok: false,
      formatter: name,
      error: stderr.trim().slice(0, 200) || `exit code ${child.code}`,
    };
  } catch (err) {
    // `Command.execute()` rejects when the OS can't spawn the program
    // at all (missing executable, denied by sidecar allowlist, etc.).
    // Treat all spawn-time errors as "soft skip" so a missing toolchain
    // never blocks an accepted diff.
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: true, formatter: `${name} (skipped: ${msg.slice(0, 80)})` };
  }
}

/**
 * Auto-format a saved file in-place using the project's configured
 * formatter. Detection is purely extension-based — see the README for
 * the full mapping.
 *
 * Always resolves; never throws.
 *
 * @param absolutePath  Absolute path of the file just written to disk.
 * @param projectPath   Project root, used as the formatter's `cwd`
 *                      so config files (`.prettierrc`, `pyproject.toml`,
 *                      `rustfmt.toml`, etc.) are picked up.
 */
export async function autoFormatFile(
  absolutePath: string,
  projectPath: string,
): Promise<AutoFormatResult> {
  const ext = extOf(absolutePath);

  if (PRETTIER_EXTS.has(ext)) {
    // `npx --no-install` would be stricter, but plain `npx` matches the
    // user's existing `pnpm format` script and falls back to fetching
    // prettier on demand.
    return runFormatter(
      "prettier",
      "npx",
      ["prettier", "--write", absolutePath],
      projectPath,
    );
  }

  if (ext === "rs") {
    return runFormatter("rustfmt", "rustfmt", [absolutePath], projectPath);
  }

  if (ext === "go") {
    return runFormatter("gofmt", "gofmt", ["-w", absolutePath], projectPath);
  }

  if (ext === "py") {
    const ruff = await runFormatter(
      "ruff",
      "ruff",
      ["format", absolutePath],
      projectPath,
    );
    // ruff returned a real error (not a missing-binary skip) — surface
    // it instead of falling through to black.
    if (!ruff.ok) return ruff;
    if (ruff.formatter && ruff.formatter.startsWith("ruff (skipped")) {
      return runFormatter("black", "black", [absolutePath], projectPath);
    }
    return ruff;
  }

  return { ok: true, formatter: "none" };
}
