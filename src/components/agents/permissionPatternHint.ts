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

/**
 * Pull the actual shell command out of a bash tool's JSON arguments so the
 * permission prompt can surface it prominently instead of burying it inside
 * `{ "command": "..." }`. Falls back to the raw string when not JSON.
 */
export function parseBashCommand(rawArgs: string): string | null {
  try {
    const parsed = JSON.parse(rawArgs) as { command?: string };
    const cmd = (parsed.command ?? "").trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    const cmd = rawArgs.trim();
    return cmd.length > 0 ? cmd : null;
  }
}

/**
 * Heuristic: does this shell command look destructive / irreversible? Used to
 * escalate the permission prompt from amber (caution) to red (danger) so a
 * `rm -rf` never looks the same as a `ls`. Intentionally conservative — false
 * positives just add a warning, they never block.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, // rm -rf / -fr
  /\bgit\s+push\b.*--force\b/i,
  /\bgit\s+push\b.*\s-f\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // curl ... | sh
  /\bchmod\s+(-R\s+)?0?777\b/i,
  /\bmkfs\b/i,
  /\b(drop\s+(database|table)|truncate\s+table)\b/i,
  /\bdd\s+if=/i,
  /:\s*\(\s*\)\s*\{.*\};\s*:/, // fork bomb
  />\s*\/dev\/sd[a-z]/i,
  /\bsudo\s+rm\b/i,
];

export function isDestructiveBash(cmd: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd));
}
