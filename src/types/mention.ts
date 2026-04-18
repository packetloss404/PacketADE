/**
 * Typed mention sources for the `@`-mention picker in the agent chat input.
 *
 * The picker can target multiple kinds of references — local files, local
 * folders, an arbitrary URL to fetch, or a git branch. Each mention is
 * inserted into the input as a tagged token so the downstream agent (or
 * pre-send substitution layer) can recognize and resolve it.
 */
export type MentionSource = "files" | "folders" | "web" | "git";

/**
 * Format a mention insertion string for the input field.
 *
 * - `files` and `folders` produce a bare `@<value>` token (existing behavior,
 *   so file/folder paths flow through unchanged for any consumer).
 * - `web` and `git` produce a typed `@<source>:<value>` token so the agent
 *   (or a future expansion pass) can distinguish them from raw paths.
 *
 * Trailing whitespace is the caller's responsibility (matches the current
 * convention in `AgentChatPane`, which appends a space after insertion).
 */
export function formatMentionInsert(
  source: MentionSource,
  value: string,
): string {
  const trimmed = value.trim();
  if (source === "files" || source === "folders") {
    return `@${trimmed}`;
  }
  return `@${source}:${trimmed}`;
}
