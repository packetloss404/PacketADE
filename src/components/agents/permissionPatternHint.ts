/**
 * Derive a human-readable rule pattern from the tool name + arguments,
 * Claude-Code style — `Bash(npm test:*)` from `npm test --watch`,
 * `Bash(git diff:*)` from `git diff HEAD`, `WriteFile(*)` for write_file, etc.
 *
 * Returns null if no useful pattern can be derived. Bails for parenthesised
 * / piped / chained shell expressions so we don't write nonsense rules like
 * `Bash((cd:*)`.
 *
 * Lives in its own module so PermissionPrompt.tsx can stay component-only
 * (Vite Fast Refresh requires `.tsx` files to export only React components).
 */
export function derivePatternHint(
  toolName: string,
  rawArgs: string,
): string | null {
  if (toolName === "bash") {
    let cmd: string;
    try {
      const parsed = JSON.parse(rawArgs) as { command?: string };
      cmd = (parsed.command ?? "").trim();
    } catch {
      cmd = rawArgs.trim();
    }
    if (!cmd) return null;
    // Strip a leading `cd ... && ` so the rule reflects the real verb.
    const withoutCd = cmd.replace(/^cd\s+\S+\s*&&\s*/, "");
    // Take up to the first two words: "npm test", "git diff", "cargo build".
    const tokens = withoutCd.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const head = tokens.slice(0, 2).join(" ");
    // Bail when the head contains shell-control characters — a rule like
    // `Bash((cd:*)` or `Bash(foo;:*)` would be both wrong and dangerous.
    if (/[()|;$`<>&]/.test(head)) return null;
    return `Bash(${head}:*)`;
  }
  if (toolName === "write_file") return "WriteFile(*)";
  if (toolName === "read_file") return "ReadFile(*)";
  if (toolName === "list_directory") return "ListDirectory(*)";
  if (toolName === "grep") return "Grep(*)";
  return null;
}
