/**
 * One voice for destructive confirms.
 *
 * The creation/deletion review found `window.confirm` in seven files plus five
 * competing confirm idioms. Everything destructive now goes through
 * `src/components/ui/ConfirmDeleteModal.tsx`. This is the regression fence:
 * `window.confirm` is unstyled, blocks the webview, renders as OS chrome that
 * does not name the app, and cannot be asserted on in a component test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if ([".ts", ".tsx"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

/**
 * A call to the global `confirm`, with or without an explicit global receiver.
 *
 * The leading `(?<![\w$.])` is what keeps the fence off identifiers that merely
 * END in the word — `showConfirm(`, `onConfirm(`, `dialog.confirm(` are all
 * somebody else's confirm, not the browser's.
 */
const NATIVE_CONFIRM = /(?<![\w$.])(?:(?:window|globalThis|self)\??\.)?confirm\s*\(/;

/** Blank out quoted spans so message strings and test titles can't trip the
 *  fence. Applied per line, so an unbalanced quote costs one line, not a file. */
function stripQuoted(line) {
  return line
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/**
 * Does this source text really call the native confirm?
 *
 * Block comments go first (they can contain stray quotes), then each line is
 * de-quoted before its line comment is stripped — that order means a `//`
 * inside a string literal is already gone and can't swallow real code.
 *
 * Split on `\r?\n`: the repo checks out CRLF on Windows, and a trailing `\r`
 * is a line terminator that `.` refuses to match.
 */
export function callsNativeConfirm(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => stripQuoted(line).replace(/\/\/.*/, ""))
    .some((line) => NATIVE_CONFIRM.test(line));
}

describe("destructive-confirm idiom", () => {
  it("no source file calls the native window.confirm", () => {
    const offenders = sourceFiles(join(ROOT, "src"))
      .filter((file) => callsNativeConfirm(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file).replaceAll("\\", "/"));

    expect(offenders).toEqual([]);
  });

  // The fence itself is load-bearing, so it gets both directions pinned. It
  // previously matched any `confirm (` outside a comment, which made a test
  // TITLE containing the words fail the build — a real bug report, not a
  // hypothetical: an earlier change had to reword a test to get past it.
  it.each([
    ["bare call", 'if (confirm("Delete this?")) remove();'],
    ["window receiver", "if (window.confirm(message)) remove();"],
    ["globalThis receiver", "const ok = globalThis.confirm(message);"],
    ["self receiver", "if (self.confirm(message)) remove();"],
    ["optional chaining", "if (window?.confirm(message)) remove();"],
    ["spaced call", "const ok = confirm  ('Delete this?');"],
    ["not on the first line", "const x = 1;\nif (confirm('sure?')) drop();"],
    ["after a stripped string on the same line", 'log("deleting"); if (confirm(msg)) drop();'],
  ])("catches a real native confirm: %s", (_name, source) => {
    expect(callsNativeConfirm(source)).toBe(true);
  });

  it.each([
    ["test title containing the word", 'it("asks the user to confirm (destructive)", () => {});'],
    ["test title, template literal", "it(`renders confirm (modal) copy`, () => {});"],
    ["camelCase identifier ending in the word", "if (showConfirm()) return;\nonConfirm(remove);"],
    ["lowercase identifier ending in the word", "if (reconfirm(value)) return;"],
    ["method on some other object", "await dialog.confirm(message);"],
    ["line comment", "// the old code called confirm( right here"],
    ["line comment on a CRLF line", "const x = 1;\r\n// it used to call confirm(msg)\r\n"],
    ["block comment", "/* window.confirm( is banned — use ConfirmDeleteModal */"],
    ["user-facing copy", 'toast("Press confirm (yes) to continue");'],
    ["a URL in a string, not a comment", 'const href = "https://example.com/confirm(1)";'],
  ])("ignores a false positive: %s", (_name, source) => {
    expect(callsNativeConfirm(source)).toBe(false);
  });

  it("the shared confirm component exists and is the one being imported", () => {
    const shared = "src/components/ui/ConfirmDeleteModal.tsx";
    expect(readFileSync(join(ROOT, shared), "utf8")).toContain("export function ConfirmDeleteModal");

    const importers = sourceFiles(join(ROOT, "src"))
      .filter((file) => /ConfirmDeleteModal/.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file).replaceAll("\\", "/"));

    // Every path the deletion sweep touched, so a silent revert to a bare
    // delete call shows up here.
    for (const expected of [
      "src/components/views/tools/ServersSettingsCard.tsx",
      "src/components/views/tools/ApiKeysCard.tsx",
      "src/components/views/tools/CrashViewerCard.tsx",
      "src/components/views/tools/TrustProvenanceCard.tsx",
      "src/components/views/tools/AgentProfilesCard.tsx",
      "src/components/views/tools/CliAgentsCard.tsx",
      "src/components/views/tools/McpServersCard.tsx",
      "src/components/views/tools/GitHubSettingsCard.tsx",
      "src/components/views/tools/PacketAgentSettingsCard.tsx",
      "src/components/views/tools/WorkspaceAgentsDogfoodCard.tsx",
      "src/components/views/MemoryView.tsx",
      "src/components/views/memory/ProjectNotesTab.tsx",
      "src/components/workspace/PromptLibrary.tsx",
      "src/components/quality/CodeQualityHistoryDropdown.tsx",
    ]) {
      expect(importers).toContain(expected);
    }
  });
});
