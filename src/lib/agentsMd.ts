import { readFileContents } from "@/lib/tauri";

/**
 * Filenames searched, in order, for project-level agent guidance. AGENTS.md
 * is the de-facto cross-tool standard (Codex, Augment, others), CLAUDE.md is
 * the older Anthropic convention. We honor both so users with a single
 * canonical instructions file in either format don't need to maintain a
 * second copy.
 *
 * The first file that exists wins — we don't concatenate. Add a project file
 * named `AGENTS.md` if you want to override a workspace-level CLAUDE.md.
 */
const CANDIDATE_FILES = ["AGENTS.md", "CLAUDE.md"];

/** Soft cap so a runaway file doesn't blow the model's context window. */
const MAX_BYTES = 32_000;

/**
 * Look for an AGENTS.md (or CLAUDE.md) file in `projectPath`. Returns the
 * file contents (truncated if huge) on success, or `null` if no candidate
 * file exists or all reads fail.
 *
 * Cascading-up-the-tree resolution (Codex's behavior) is deferred — most
 * users keep these files at the repo root, and the existing `readFileContents`
 * Tauri command already enforces project-path sandboxing for us.
 */
export async function loadAgentsMd(
  projectPath: string,
): Promise<string | null> {
  if (!projectPath) return null;
  for (const name of CANDIDATE_FILES) {
    try {
      // The Rust read command takes (filePath, workspace). Both are the same
      // path here — the workspace arg is the security scope, the filePath
      // is the file to read inside that scope.
      const content = await readFileContents(`${projectPath}/${name}`, projectPath);
      if (typeof content !== "string") continue;
      if (content.length === 0) continue;
      const truncated =
        content.length > MAX_BYTES
          ? `${content.slice(0, MAX_BYTES)}\n\n…(truncated, ${content.length - MAX_BYTES} bytes more in file)`
          : content;
      return truncated;
    } catch {
      // Missing file (most common) or read error — try the next candidate.
      continue;
    }
  }
  return null;
}
