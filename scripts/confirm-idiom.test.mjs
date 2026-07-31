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

/** Strip comments so prose mentions of the banned API don't count. */
function code(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("destructive-confirm idiom", () => {
  it("no source file calls the native window.confirm", () => {
    const offenders = sourceFiles(join(ROOT, "src"))
      .filter((file) => /(?<![\w.$])(?:window\.)?confirm\s*\(/.test(code(readFileSync(file, "utf8"))))
      .map((file) => relative(ROOT, file).replaceAll("\\", "/"));

    expect(offenders).toEqual([]);
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
