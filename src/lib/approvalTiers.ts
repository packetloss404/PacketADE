import {
  EDIT_TOOL_NAMES,
  parseEditToolCalls,
  parseToolInput,
  toProjectRelativePath,
} from "@/lib/parseToolInput";
import type { AgentToolCall } from "@/types/agent-conversation";

/**
 * Tiered approval gating (consensus P1-9).
 *
 * Every incoming `permission_request` is classified into one of three tiers
 * BEFORE it can become a blocking prompt:
 *
 * - `"read"`            — read/search tools. Never prompt: they cannot
 *                         change anything, and a prompt for `Grep` teaches
 *                         users to click Allow without reading.
 * - `"edit_in_project"` — file edits whose every touched path resolves
 *                         inside the conversation's project. Auto-applied
 *                         into the post-hoc review bar: the P1-7 baseline
 *                         pipeline records the true "before" and the P1-8
 *                         ReviewBar/ReviewSurface owns Keep/Undo. (When the
 *                         approve-writes fine flag is ON, the blocking
 *                         `pending_edit` diff gate still applies — this tier
 *                         only removes the redundant permission prompt in
 *                         front of it.)
 * - `"blocking"`        — everything that deserves a human: shell, network,
 *                         out-of-project writes, and any tool we cannot
 *                         positively classify (MCP tools, unknown names,
 *                         unparseable edit inputs).
 *
 * The mode chip stays the source of truth (P0-4 bijection): tiering applies
 * under Default (and the strictly-more-permissive yolo); `manual`
 * ("Ask for risky") auto-allows only reads; plan and deny-risky modes keep
 * their stricter prompt-everything-that-arrives behavior.
 */

export type ApprovalTier = "read" | "edit_in_project" | "blocking";

/** Mirrors `AgentMode` from AgentModeChip — callers derive it with
 * `deriveMode` (agentModeChipUtils), which stays the one bijection over the
 * conversation's flag fields. */
export type ApprovalGateMode = "default" | "plan" | "manual" | "deny" | "yolo";

/**
 * Read/search tool names across every runtime PacketADE fronts. Anything
 * NOT in this set that also isn't a recognized edit tool is blocking —
 * the list is deliberately conservative (no network tools: WebFetch /
 * WebSearch stay blocking per the consensus ruling).
 *
 * - Claude Code SDK: Read / Glob / Grep / LS / NotebookRead, TodoWrite
 *   (session-state todo mirror — writes no files), BashOutput (reads the
 *   output of an already-approved shell).
 * - In-process providers + openai-agents sidecar: read_file /
 *   list_directory / grep.
 */
const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "BashOutput",
  "read_file",
  "list_directory",
  "grep",
]);

/** Absolute in any OS vocabulary: POSIX, home-relative, Windows drive, UNC. */
function isAbsolutePath(p: string): boolean {
  return (
    p.startsWith("/") ||
    p.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(p) ||
    p.startsWith("\\\\")
  );
}

/**
 * True when `rawPath` provably resolves inside `projectPath`. Relative
 * paths count as in-project (tools run with the project as cwd) unless they
 * climb out via `..`. Absolute paths must sit under the project root —
 * `toProjectRelativePath` relativizes exactly those, so anything still
 * absolute after it is out-of-project.
 */
export function isPathInProject(
  rawPath: string,
  projectPath: string | undefined,
): boolean {
  const rel = toProjectRelativePath(rawPath, projectPath);
  if (isAbsolutePath(rel)) return false;
  return !rel.replace(/\\/g, "/").split("/").includes("..");
}

/** Last-resort path sniff for edit tools whose canonical descriptor parse
 * came back empty (e.g. a `Write` with a non-string `content` still names
 * its `file_path`). */
function fallbackEditPaths(rawArgs: string): string[] {
  const rec = parseToolInput(rawArgs);
  if (!rec) return [];
  const candidate = [rec.file_path, rec.notebook_path, rec.path].find(
    (v): v is string => typeof v === "string",
  );
  return candidate ? [candidate] : [];
}

/**
 * Classify one permission request (tool name + raw JSON arguments) into an
 * approval tier. `projectPath` is the owning conversation's project root.
 */
export function classifyToolTier(
  toolName: string,
  rawArgs: string,
  projectPath: string | undefined,
): ApprovalTier {
  if (READ_TOOL_NAMES.has(toolName)) return "read";
  if (EDIT_TOOL_NAMES.has(toolName)) {
    // Reuse THE tool-name normalization map (P1-7) so the tier classifier
    // and the review surface agree about which files a call touches.
    const descriptors = parseEditToolCalls({
      id: "gate",
      name: toolName,
      status: "running",
      input: rawArgs,
    } as AgentToolCall);
    const paths =
      descriptors.length > 0
        ? descriptors.map((d) => d.path)
        : fallbackEditPaths(rawArgs);
    if (paths.length > 0 && paths.every((p) => isPathInProject(p, projectPath))) {
      return "edit_in_project";
    }
    // No provable paths, or at least one escapes the project: a human looks.
    return "blocking";
  }
  return "blocking";
}

/**
 * The mode × tier gate. Returns `"auto_allow"` when the request should be
 * answered `allow_once` without ever rendering a prompt, `"prompt"` when it
 * must block on the user.
 */
export function decideApprovalGate(
  mode: ApprovalGateMode,
  tier: ApprovalTier,
): "auto_allow" | "prompt" {
  switch (mode) {
    case "plan":
    case "deny":
      // Stricter postures keep every prompt that reaches the frontend.
      return "prompt";
    case "manual":
      // "Ask for risky": reads are never risky; everything else asks.
      return tier === "read" ? "auto_allow" : "prompt";
    case "yolo":
    case "default":
      return tier === "blocking" ? "prompt" : "auto_allow";
  }
}
