import type {
  AgentConversation,
  AgentToolCall,
} from "@/types/agent-conversation";

/**
 * Latest-wins aggregate entry for a single file in a conversation.
 * `content` is the most recent `write_file` payload for `path`.
 */
export interface WriteFileEntry {
  path: string;
  content: string;
  writeCount: number;
}

/**
 * Parse a `write_file` tool call into `{ path, content }`. Tolerant of both
 * stringified-JSON `input` and structured `{ input: {...} }` shapes. Returns
 * null when the call isn't a recognizable `write_file`.
 */
export function parseWriteFile(
  tc: AgentToolCall,
): { path: string; content: string } | null {
  if (tc.name !== "write_file") return null;
  const raw = (tc as AgentToolCall & { input?: unknown }).input;
  if (raw == null) return null;
  try {
    let obj: unknown = raw;
    if (typeof raw === "string") obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      const rec = obj as Record<string, unknown>;
      const path =
        typeof rec.path === "string"
          ? rec.path
          : typeof rec.file_path === "string"
            ? rec.file_path
            : undefined;
      const content =
        typeof rec.content === "string" ? rec.content : undefined;
      if (path && content != null) return { path, content };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Walk a conversation and reduce all `write_file` tool calls into a per-path
 * map. Chronological iteration order means `content` ends up holding the
 * latest payload while `writeCount` totals every write seen.
 */
export function aggregateWriteFiles(
  conv: AgentConversation | undefined,
): Map<string, WriteFileEntry> {
  const map = new Map<string, WriteFileEntry>();
  if (!conv) return map;
  for (const msg of conv.messages) {
    if (!msg.toolCalls?.length) continue;
    for (const tc of msg.toolCalls) {
      const parsed = parseWriteFile(tc);
      if (!parsed) continue;
      const existing = map.get(parsed.path);
      map.set(parsed.path, {
        path: parsed.path,
        content: parsed.content,
        writeCount: (existing?.writeCount ?? 0) + 1,
      });
    }
  }
  return map;
}

/**
 * Combine a project root with a relative file path to produce the absolute
 * path expected by `writeFileContents`. Preserves the project's existing
 * separator style ('\\' on Windows project paths, '/' otherwise).
 */
export function joinAbsolutePath(
  projectPath: string,
  relPath: string,
): string {
  const usesBackslash =
    projectPath.includes("\\") && !projectPath.includes("/");
  const sep = usesBackslash ? "\\" : "/";
  const trimmedRoot = projectPath.replace(/[\\/]+$/, "");
  const trimmedRel = relPath.replace(/^[\\/]+/, "");
  const normalizedRel = usesBackslash
    ? trimmedRel.replace(/\//g, "\\")
    : trimmedRel.replace(/\\/g, "/");
  return `${trimmedRoot}${sep}${normalizedRel}`;
}
