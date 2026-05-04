import { resolveAgentsMd } from "@/lib/tauri";

/**
 * Project-rules loader. Returns the cascading AGENTS.md / CLAUDE.md
 * resolution for `projectPath`, or null when no candidate file exists
 * anywhere in the cascade.
 *
 * The actual walk happens Rust-side in `core::agents_md::resolve` so
 * `~/.claude/AGENTS{,.override}.md` and per-directory candidates from
 * git-root down to cwd are concatenated atomically with the 32 KiB cap
 * applied to the joined output (matches Codex CLI 0.122+'s behavior).
 *
 * Failures are swallowed — a missing project / unreadable file is the
 * common case, never blocking a launch.
 */
export async function loadAgentsMd(
  projectPath: string,
): Promise<string | null> {
  if (!projectPath) return null;
  try {
    return await resolveAgentsMd(projectPath);
  } catch {
    return null;
  }
}
