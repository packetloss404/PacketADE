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
  const path =
    typeof rec.path === "string"
      ? rec.path
      : typeof rec.file_path === "string"
        ? rec.file_path
        : undefined;
  const content = typeof rec.content === "string" ? rec.content : undefined;
  if (path && content != null) return { path, content };
  return null;
}
