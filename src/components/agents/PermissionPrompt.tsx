import { ShieldAlert, Check, X } from "lucide-react";

interface PermissionPromptProps {
  item: { id: string; name: string; arguments: string };
  onAllowOnce: (toolId: string) => void;
  onAllowAlways: (toolId: string) => void;
  onDeny: (toolId: string) => void;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * Derive a human-readable rule pattern from the tool name + arguments,
 * Claude-Code style — `Bash(npm test:*)` from `npm test --watch`,
 * `Bash(git diff:*)` from `git diff HEAD`, `WriteFile(*)` for write_file, etc.
 *
 * Returns null if no useful pattern can be derived (caller falls back to a
 * generic "Always allow this tool" label).
 */
function derivePatternHint(toolName: string, rawArgs: string): string | null {
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
    return `Bash(${head}:*)`;
  }
  if (toolName === "write_file") return "WriteFile(*)";
  if (toolName === "read_file") return "ReadFile(*)";
  if (toolName === "list_directory") return "ListDirectory(*)";
  if (toolName === "grep") return "Grep(*)";
  return null;
}

export function PermissionPrompt({ item, onAllowOnce, onAllowAlways, onDeny }: PermissionPromptProps) {
  const pattern = derivePatternHint(item.name, item.arguments);
  return (
    <div className="bg-bg-secondary border border-accent-amber/40 rounded p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} className="text-accent-amber shrink-0" />
        <span className="text-xs text-text-primary">
          Run <code className="font-mono text-accent-amber">{item.name}</code>?
        </span>
      </div>
      <pre className="text-[10px] font-mono bg-bg-primary rounded p-2 max-h-32 overflow-auto text-text-secondary whitespace-pre-wrap">
        {prettyJson(item.arguments)}
      </pre>
      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => onAllowOnce(item.id)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
        >
          <Check size={12} /> Allow once
        </button>
        <button
          type="button"
          onClick={() => onAllowAlways(item.id)}
          title={
            pattern
              ? `Always allow this pattern: ${pattern}`
              : "Always allow this tool for the rest of the session"
          }
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
        >
          <Check size={12} /> Always allow
          {pattern && (
            <code className="ml-1 font-mono text-[10px] text-accent-green/80 bg-accent-green/10 px-1 rounded">
              {pattern}
            </code>
          )}
        </button>
        <button
          type="button"
          onClick={() => onDeny(item.id)}
          className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-red/40 text-accent-red hover:bg-accent-red/10"
        >
          <X size={12} /> Deny
        </button>
      </div>
    </div>
  );
}
