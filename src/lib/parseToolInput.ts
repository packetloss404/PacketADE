import type { AgentToolCall } from "@/types/agent-conversation";

/**
 * Decode a tool call's raw `input` into a plain record.
 *
 * The type says `input?: string`, but at runtime the sidecars are
 * inconsistent about the wire shape: most hand over the JSON string the
 * model produced, while some replay/persistence paths deliver an
 * already-parsed object. Every consumer must hedge on both — this is the
 * single canonical hedge (lifted from ToolCallCard's correct version).
 *
 * Returns null when the input is missing, malformed JSON, or doesn't
 * decode to an object.
 */
export function parseToolInput(
  raw: unknown,
): Record<string, unknown> | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (obj && typeof obj === "object") {
    return obj as Record<string, unknown>;
  }
  return null;
}

/**
 * Parse a `write_file`-shaped tool call input into `{ path, content }`.
 * Tolerant of both stringified-JSON and structured `input` shapes, and of
 * the `path` vs `file_path` field-name split across CLIs. Returns null
 * when unavailable or malformed. Does NOT check `tc.name` — callers that
 * need the guard apply it themselves.
 */
export function parseWriteFileInput(
  tc: AgentToolCall,
): { path: string; content: string } | null {
  const rec = parseToolInput(
    (tc as AgentToolCall & { input?: unknown }).input,
  );
  if (!rec) return null;
  const path = pickPath(rec);
  const content = typeof rec.content === "string" ? rec.content : undefined;
  if (path && content != null) return { path, content };
  return null;
}

/* -------------------------------------------------------------------------- */
/*              Canonical edit descriptors (tool-name normalization)          */
/* -------------------------------------------------------------------------- */

/** One `old_string` → `new_string` replacement (Claude Code Edit/MultiEdit). */
export interface EditReplacement {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/**
 * Provider-neutral description of one file touched by an edit-bearing tool
 * call. Exactly one of the content fields is populated per source tool:
 *
 * - `after`        — full proposed file content (write_file / Write /
 *                    NotebookEdit / apply_patch Add File sections).
 * - `replacements` — search/replace ops (Edit / MultiEdit); need a baseline
 *                    ("before" content) to materialize into `after` — see
 *                    `materializeEdits`.
 * - neither        — the tool only names the path (Codex apply_patch
 *                    Update File sections / `changes` lists). Consumers fall
 *                    back to reading the applied result from disk.
 */
export interface CanonicalEdit {
  path: string;
  /** Full proposed file content, when the tool call carries it. */
  after?: string;
  /** Ordered replacement ops that transform the baseline into `after`. */
  replacements?: EditReplacement[];
}

/**
 * Every provider tool name that writes file content. One set so the
 * transcript edit layer (grouping, diff aggregation, review prompts) fires
 * on every runtime instead of only the legacy in-process `write_file`:
 *
 * - `write_file` / `edit_file` — in-process LlmProvider (+ `write_file` on
 *   the openai-agents sidecar)
 * - `Write` / `Edit` / `MultiEdit` / `NotebookEdit` — Claude Code SDK
 * - `apply_patch` — Codex CLI
 */
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
]);

export function isEditToolName(name: string): boolean {
  return EDIT_TOOL_NAMES.has(name);
}

/**
 * Normalize an in-project absolute path (Claude Code's `file_path` and,
 * typically, Codex change paths are absolute) to the project-relative form
 * the review surfaces expect — `read_file_for_diff` hard-rejects absolute
 * paths, and baseline-store keys must match the transcript's descriptor
 * paths. Already-relative and out-of-project paths pass through unchanged.
 */
export function toProjectRelativePath(
  path: string,
  projectPath: string | undefined,
): string {
  if (!projectPath) return path;
  const normalized = path.replace(/\\/g, "/");
  const root = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root.length === 0 || !normalized.startsWith(`${root}/`)) return path;
  return normalized.slice(root.length + 1);
}

/** `path` vs `file_path` vs `notebook_path` field-name split across CLIs. */
function pickPath(rec: Record<string, unknown>): string | undefined {
  if (typeof rec.path === "string") return rec.path;
  if (typeof rec.file_path === "string") return rec.file_path;
  if (typeof rec.notebook_path === "string") return rec.notebook_path;
  return undefined;
}

function parseReplacement(raw: unknown): EditReplacement | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (
    typeof rec.old_string !== "string" ||
    typeof rec.new_string !== "string"
  ) {
    return null;
  }
  return {
    oldString: rec.old_string,
    newString: rec.new_string,
    replaceAll: rec.replace_all === true,
  };
}

/**
 * Parse a Codex `apply_patch` envelope ("*** Begin Patch" … "*** End Patch")
 * into per-file descriptors. Add File sections carry their full content in
 * `+` lines; Update File sections only name the path (consumers read the
 * applied result from disk); Delete File maps to `after: ""`.
 */
function parsePatchEnvelope(patch: string): CanonicalEdit[] {
  const out: CanonicalEdit[] = [];
  const lines = patch.split("\n");
  let addPath: string | null = null;
  let addLines: string[] = [];
  const flushAdd = () => {
    if (addPath !== null) {
      out.push({ path: addPath, after: addLines.join("\n") });
    }
    addPath = null;
    addLines = [];
  };
  for (const line of lines) {
    const add = line.match(/^\*\*\* Add File: (.+)$/);
    const update = line.match(/^\*\*\* Update File: (.+)$/);
    const del = line.match(/^\*\*\* Delete File: (.+)$/);
    if (add) {
      flushAdd();
      addPath = add[1].trim();
      continue;
    }
    if (update || del || line.startsWith("*** ")) {
      flushAdd();
      if (update) out.push({ path: update[1].trim() });
      if (del) out.push({ path: del[1].trim(), after: "" });
      continue;
    }
    if (addPath !== null && line.startsWith("+")) {
      addLines.push(line.slice(1));
    }
  }
  flushAdd();
  return out;
}

/** Extract per-file descriptors from a Codex `apply_patch` / `file_change`
 * tool input. Handles both the patch-envelope string (under `patch` /
 * `input`, or the whole input being the patch string) and the structured
 * `changes: [{ path, kind }]` list the Codex CLI emits on file_change
 * items. */
function parseApplyPatchInput(raw: unknown): CanonicalEdit[] {
  const rec = parseToolInput(raw);
  if (rec) {
    const patch =
      typeof rec.patch === "string"
        ? rec.patch
        : typeof rec.input === "string"
          ? rec.input
          : undefined;
    if (patch && patch.includes("*** Begin Patch")) {
      return parsePatchEnvelope(patch);
    }
    if (Array.isArray(rec.changes)) {
      const out: CanonicalEdit[] = [];
      for (const change of rec.changes) {
        if (typeof change === "string") {
          out.push({ path: change });
          continue;
        }
        if (!change || typeof change !== "object") continue;
        const c = change as Record<string, unknown>;
        const path = pickPath(c);
        if (!path) continue;
        const kind = typeof c.kind === "string" ? c.kind : c.type;
        out.push(kind === "delete" ? { path, after: "" } : { path });
      }
      return out;
    }
    return [];
  }
  // Some Codex builds pass the bare envelope text as the tool argument.
  if (typeof raw === "string" && raw.includes("*** Begin Patch")) {
    return parsePatchEnvelope(raw);
  }
  return [];
}

/**
 * THE normalization map from provider tool names to canonical edit
 * descriptors. Returns one entry per file the call touches (apply_patch can
 * touch several), or `[]` for non-edit tools and unparseable inputs.
 * Tolerant of both stringified-JSON and structured `input` shapes.
 *
 * Pass `projectPath` so descriptor paths come back project-relative (via
 * {@link toProjectRelativePath}) — the shape `read_file_for_diff` and the
 * baseline store key on. Omit it only when the caller does not resolve
 * paths against the project (e.g. pure existence checks).
 */
export function parseEditToolCalls(
  tc: AgentToolCall,
  projectPath?: string,
): CanonicalEdit[] {
  if (!EDIT_TOOL_NAMES.has(tc.name)) return [];
  const raw = (tc as AgentToolCall & { input?: unknown }).input;
  if (tc.name === "apply_patch") {
    return parseApplyPatchInput(raw).map((edit) => ({
      ...edit,
      path: toProjectRelativePath(edit.path, projectPath),
    }));
  }
  const rec = parseToolInput(raw);
  if (!rec) return [];
  const rawPath = pickPath(rec);
  if (!rawPath) return [];
  const path = toProjectRelativePath(rawPath, projectPath);
  switch (tc.name) {
    case "write_file":
    case "Write": {
      if (typeof rec.content !== "string") return [];
      return [{ path, after: rec.content }];
    }
    case "edit_file":
    case "Edit": {
      const replacement = parseReplacement(rec);
      if (!replacement) return [];
      return [{ path, replacements: [replacement] }];
    }
    case "MultiEdit": {
      if (!Array.isArray(rec.edits)) return [];
      const replacements = rec.edits
        .map(parseReplacement)
        .filter((r): r is EditReplacement => r !== null);
      if (replacements.length === 0) return [];
      return [{ path, replacements }];
    }
    case "NotebookEdit": {
      // Previewed the same way the sidecar's pending_edit hook previews it:
      // the new cell source stands in for the file content. Full .ipynb
      // cell-level diffing is a future refinement.
      if (typeof rec.new_source !== "string") return [];
      return [{ path, after: rec.new_source }];
    }
    default:
      return [];
  }
}

/** True when the call is an edit-bearing tool whose input names at least
 * one file — the guard the transcript layer (grouping, diff aggregation)
 * keys on instead of `tc.name === "write_file"`. */
export function isEditToolCall(tc: AgentToolCall): boolean {
  return parseEditToolCalls(tc).length > 0;
}

/**
 * Apply Edit/MultiEdit replacements to `before` exactly the way the SDK's
 * Edit tool does (mirrors the sidecar's applyEditReplacement), so the diff
 * we render matches what the tool actually produced. An empty or unmatched
 * `oldString` leaves the content unchanged.
 */
export function applyEditReplacements(
  before: string,
  replacements: EditReplacement[],
): string {
  let current = before;
  for (const { oldString, newString, replaceAll } of replacements) {
    if (oldString.length === 0) continue;
    if (replaceAll) {
      // split/join is the no-regex "replace all literal" and preserves
      // `newString` verbatim (no $& backreferences).
      current = current.split(oldString).join(newString);
      continue;
    }
    const idx = current.indexOf(oldString);
    if (idx < 0) continue;
    current =
      current.slice(0, idx) +
      newString +
      current.slice(idx + oldString.length);
  }
  return current;
}

/**
 * Replay a chronological list of canonical edits for one path on top of a
 * recorded baseline to produce the final proposed content. Returns null
 * when the chain can't be reproduced from the transcript alone — a
 * replacement chain with no baseline, or a path-only descriptor (Codex
 * apply_patch Update File) — in which case callers fall back to reading
 * the applied result from disk.
 */
export function materializeEdits(
  edits: CanonicalEdit[],
  baseline: string | null,
): string | null {
  let current: string | null = baseline;
  for (const edit of edits) {
    if (typeof edit.after === "string") {
      current = edit.after;
      continue;
    }
    if (edit.replacements && edit.replacements.length > 0) {
      if (current === null) return null;
      current = applyEditReplacements(current, edit.replacements);
      continue;
    }
    // Path-only descriptor: the transcript doesn't carry the content.
    return null;
  }
  return current;
}
