import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

/**
 * Read-once cache. These fences scan every file under `src/` for a dozen
 * patterns; re-reading the tree per pattern made them take 9-25 s and time out
 * against vitest's 5 s default whenever the disk was busy — a fence that fails
 * for reasons unrelated to what it guards is worse than no fence.
 */
const FILE_CONTENTS = new Map();
function contentsOf(file) {
  let text = FILE_CONTENTS.get(file);
  if (text === undefined) {
    text = readFileSync(file, "utf8");
    FILE_CONTENTS.set(file, text);
  }
  return text;
}

const ROOT = process.cwd();

function sourceFiles(root, extensions) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...sourceFiles(path, extensions));
    } else if (extensions.has(extname(entry.name)) && !/\.(?:test|spec)\.[^.]+$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function matchingFiles(files, pattern, allowed = []) {
  const allowedSet = new Set(allowed);
  return files
    .filter((file) => !allowedSet.has(relative(ROOT, file).replaceAll("\\", "/")))
    .filter((file) => pattern.test(contentsOf(file)))
    .map((file) => relative(ROOT, file).replaceAll("\\", "/"))
    .sort();
}

const frontendSources = sourceFiles(join(ROOT, "src"), new Set([".ts", ".tsx"]));
const rustSources = sourceFiles(join(ROOT, "src-tauri", "src"), new Set([".rs"]));

// Filesystem fences, not unit tests — see confirm-idiom.test.mjs.
const FENCE_TIMEOUT_MS = 30_000;

describe("Workspace/Agents north-star boundaries", () => {
  it("keeps new GUI-agent creation out of current Workspace entry surfaces", () => {
    expect(matchingFiles(frontendSources, /\baddDraft\s*\(/)).toEqual([]);

    for (const path of [
      "src/components/views/WorkspaceView.tsx",
      "src/components/workspace/WorkspaceCreationModal.tsx",
      "src/components/workspace/AddSessionPicker.tsx",
    ]) {
      const source = read(path);
      expect(source, path).not.toMatch(
        /\b(?:launchConversation|API_PROVIDERS|addConversationPane|useAgentTaskStore)\b/,
      );
    }

    const agentsView = read("src/components/views/AgentsView.tsx");
    expect(agentsView).toContain("launchConversation({");
    expect(agentsView).not.toMatch(/\bonLaunched\s*:/);
  }, FENCE_TIMEOUT_MS);

  it("keeps saved conversation panes read-compatible without any new attachment producer", () => {
    expect(matchingFiles(frontendSources, /\bopenSession\s*\(/)).toEqual([]);
    expect(matchingFiles(frontendSources, /\baddConversationPane\b/)).toEqual([]);
    expect(matchingFiles(frontendSources, /\bensureConversationWorkspace\b/)).toEqual([]);
    expect(matchingFiles(frontendSources, /\battachConversationToWorkspace\b/)).toEqual([]);
    expect(matchingFiles(frontendSources, /\bopenConversationAlongsideWorkspace\b/)).toEqual([]);
    expect(matchingFiles(frontendSources, /\bDraftTile\b/)).toEqual([]);

    const glue = read("src/stores/sessionGlue.ts");
    expect(glue).toContain("export function openConversationInAgents");
    expect(glue).toContain("removeConversationPanes");

    const mosaic = read("src/components/workspace/WorkspaceMosaicContainer.tsx");
    expect(mosaic).toContain('pane.kind === "conversation"');
    expect(mosaic).toContain("<ConversationTile");
  }, FENCE_TIMEOUT_MS);

  it("keeps every secondary native window on the reviewed Monitor path", () => {
    expect(
      matchingFiles(rustSources, /\bWebviewWindowBuilder\b/, [
        "src-tauri/src/commands/monitor_windows.rs",
      ]),
    ).toEqual([]);
    expect(matchingFiles(frontendSources, /\bnew\s+WebviewWindow\b/)).toEqual([]);

    const monitor = read("src/components/monitor/MonitorApp.tsx");
    expect(monitor).toContain("await refreshConversationProjection()");
    expect(monitor).not.toContain("hydrateConversations(");

    const capability = JSON.parse(read("src-tauri/capabilities/monitor.json"));
    expect(capability.windows).toEqual(["monitor-*"]);
    expect(capability.permissions).not.toContain("shell:default");
    expect(capability.permissions).not.toContain("fs:default");
    expect(capability.permissions).not.toContain("process:default");
  }, FENCE_TIMEOUT_MS);
});
