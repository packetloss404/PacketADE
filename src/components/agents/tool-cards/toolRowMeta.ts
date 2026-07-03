import {
  Bot,
  CheckSquare,
  Github,
  Globe,
  GitPullRequest,
  Plug,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { parseToolInput } from "@/lib/parseToolInput";
import type { AgentToolCall } from "@/types/agent-conversation";

export interface ToolRowMeta {
  icon: LucideIcon;
  verb: string;
  target: string;
}

/** `url` → `path`/`file_path` → `title` → `query`/`pattern` — the target
 * extraction order for tools that don't have a more specific mapping below.
 * Always falls back gracefully since `parseToolInput` already hedges
 * undecodable JSON. */
function pickTarget(args: Record<string, unknown>): string {
  const candidates = [
    "url",
    "path",
    "file_path",
    "title",
    "query",
    "pattern",
    "command",
  ];
  for (const key of candidates) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

/** Strip an `mcp__server__toolName` name down to a readable
 * `server: toolName`-ish label for display. */
function prettyMcpName(name: string): string {
  const parts = name.split("__");
  // ["mcp", "server", "toolName", ...]
  if (parts.length >= 3) return parts.slice(2).join("__");
  return name;
}

/**
 * Pure mapping from a tool call to its uniform one-line verb-row
 * presentation: icon, verb, and scannable target. Used by the generic
 * (non-edit, non-bash, non-subagent, non-task-list) branch of ToolCallCard.
 */
export function toolRowMeta(tc: AgentToolCall): ToolRowMeta {
  const args = parseToolInput(tc.input) ?? {};
  const name = tc.name;

  if (name === "web_fetch") {
    return {
      icon: Globe,
      verb: "Fetched",
      target: typeof args.url === "string" ? args.url : pickTarget(args),
    };
  }

  if (name === "create_pull_request") {
    return {
      icon: GitPullRequest,
      verb: "Opened PR",
      target: typeof args.title === "string" ? args.title : pickTarget(args),
    };
  }

  if (name === "task_create") {
    return {
      icon: CheckSquare,
      verb: "Created task",
      target:
        typeof args.title === "string"
          ? args.title
          : typeof args.name === "string"
            ? args.name
            : pickTarget(args),
    };
  }

  if (name === "task_update") {
    return {
      icon: CheckSquare,
      verb: "Updated task",
      target:
        typeof args.title === "string"
          ? args.title
          : typeof args.name === "string"
            ? args.name
            : pickTarget(args),
    };
  }

  if (name.startsWith("mcp__")) {
    return {
      icon: Plug,
      verb: "Called",
      target: prettyMcpName(name),
    };
  }

  if (name.startsWith("gh_")) {
    return {
      icon: Github,
      verb: "GitHub",
      target: name.slice("gh_".length),
    };
  }

  if (name.startsWith("agent_")) {
    return {
      icon: Bot,
      verb: "Called agent",
      target: name.slice("agent_".length),
    };
  }

  // Fallback: any tool without a dedicated mapping above (including
  // Claude Code's uppercase "Bash", which is out of this item's blast
  // radius to reroute to BashToolCallCard — this just gives it a
  // reasonable one-line target instead of nothing).
  const fallbackTarget =
    tc.file ??
    (typeof args.command === "string" ? args.command : undefined) ??
    tc.summary?.split("\n")[0] ??
    "";
  return {
    icon: Wrench,
    verb: name,
    target: fallbackTarget,
  };
}
