import { toProjectRelativePath } from "@/lib/parseToolInput";
import type {
  AgentConversation,
  AgentMessage,
} from "@/types/agent-conversation";
import {
  PROVENANCE_SCHEMA_VERSION,
  type ProvenanceEnvelope,
  type ProvenanceOrigin,
  type ProvenanceTransform,
} from "@/types/provenance";

const WEB_TOOL_NAMES = new Set(["web_fetch", "web_search", "WebFetch", "WebSearch"]);
const MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get", "search_memory"]);
const AGENT_TOOL_NAMES = new Set(["spawn_subagent", "Task", "task"]);
const FILE_TOOL_NAMES = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "read_file",
  "list_directory",
  "grep",
]);

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function attachmentProvenance(
  messageId: string,
  attachments: Array<{ media_type: string; data_base64: string }>,
  capturedAt = Date.now(),
): ProvenanceEnvelope[] {
  return attachments.map((attachment, index) => ({
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    id: `prov_attachment_${messageId}_${index}`,
    origin: "imported_file",
    authority: "evidence_only",
    identity: {
      label: `Imported attachment · ${attachment.media_type || "unknown type"}`,
      locator: attachment.media_type || undefined,
    },
    integrity: {
      capturedAt,
      state: "unverified",
      contentHash: stableHash(attachment.data_base64),
      hashAlgorithm: "fnv1a64",
      transforms: ["extracted"],
    },
    lineage: { parentIds: [] },
  }));
}

function safeJson(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function safeWebLocator(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const pathname = url.pathname.length > 160 ? `${url.pathname.slice(0, 157)}…` : url.pathname;
    return `${url.origin}${pathname}`;
  } catch {
    return undefined;
  }
}

export function safeToolLocator(
  name: string,
  input: string | undefined,
  projectPath?: string,
): string | undefined {
  const parsed = safeJson(input);
  if (WEB_TOOL_NAMES.has(name)) {
    return safeWebLocator(firstString(parsed, ["url", "uri"]));
  }
  if (name.startsWith("mcp__")) {
    return name.split("__").slice(0, 3).join("__").slice(0, 180);
  }
  const path = firstString(parsed, [
    "path",
    "file_path",
    "notebook_path",
    "directory",
  ]);
  if (path) return toProjectRelativePath(path, projectPath).slice(0, 180);
  return undefined;
}

function originForTool(name: string, remote: boolean): ProvenanceOrigin {
  if (WEB_TOOL_NAMES.has(name)) return "web";
  if (name.startsWith("mcp__")) return "mcp";
  if (MEMORY_TOOL_NAMES.has(name)) return "memory";
  if (AGENT_TOOL_NAMES.has(name)) return "agent";
  if (FILE_TOOL_NAMES.has(name)) {
    return remote ? "remote_workspace" : "local_workspace";
  }
  return "unknown";
}

export function toolResultProvenance(args: {
  toolId: string;
  name: string;
  input?: string;
  content?: string;
  projectPath?: string;
  remote?: boolean;
  capturedAt?: number;
}): ProvenanceEnvelope {
  const origin = originForTool(args.name, args.remote ?? false);
  const transforms: ProvenanceTransform[] = [];
  if (origin === "web") transforms.push("extracted");
  if (args.content?.includes("[UNTRUSTED WEB CONTENT")) transforms.push("redacted");
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    id: `prov_tool_${args.toolId}`,
    origin,
    authority: "evidence_only",
    identity: {
      label:
        origin === "web"
          ? "Web evidence"
          : origin === "mcp"
            ? `MCP · ${args.name.split("__")[1] ?? "server"}`
            : origin === "remote_workspace"
              ? "Remote workspace"
              : origin === "local_workspace"
                ? "Local workspace"
                : origin === "memory"
                  ? "Memory"
                  : origin === "agent"
                    ? "Agent result"
                    : "Unknown tool result",
      locator: safeToolLocator(args.name, args.input, args.projectPath),
    },
    integrity: {
      capturedAt: args.capturedAt ?? Date.now(),
      state: origin === "local_workspace" ? "verified" : "unverified",
      contentHash: args.content ? stableHash(args.content) : undefined,
      hashAlgorithm: args.content ? "fnv1a64" : undefined,
      transforms,
    },
    lineage: { parentIds: [] },
  };
}

export function userIntentProvenance(
  messageId: string,
  capturedAt = Date.now(),
): ProvenanceEnvelope {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    id: `prov_message_${messageId}`,
    origin: "user",
    authority: "user_intent",
    identity: { label: "User message" },
    integrity: {
      capturedAt,
      state: "verified",
      transforms: [],
    },
    lineage: { parentIds: [] },
  };
}

export function unknownProvenance(
  id: string,
  label: string,
  capturedAt: number,
): ProvenanceEnvelope {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    id: `prov_legacy_${id}`,
    origin: "unknown",
    authority: "evidence_only",
    identity: { label },
    integrity: {
      capturedAt,
      state: "unknown",
      transforms: [],
    },
    lineage: { parentIds: [] },
  };
}

export function assistantDerivativeProvenance(
  message: AgentMessage,
  additionalParents: ProvenanceEnvelope[] = [],
): ProvenanceEnvelope {
  const parentIds = Array.from(
    new Set([
      ...(message.toolCalls ?? [])
        .map((tool) => tool.provenance?.id)
        .filter((id): id is string => Boolean(id)),
      ...additionalParents.map((parent) => parent.id),
    ]),
  );
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    id: `prov_message_${message.id}`,
    origin: "generated_derivative",
    authority: "evidence_only",
    identity: { label: "Agent-generated response" },
    integrity: {
      capturedAt: message.timestamp,
      state: "unverified",
      contentHash: message.content ? stableHash(message.content) : undefined,
      hashAlgorithm: message.content ? "fnv1a64" : undefined,
      transforms: parentIds.length > 0 ? ["summarized"] : [],
    },
    lineage: { parentIds },
  };
}

export function derivedArtifactProvenance(
  id: string,
  label: string,
  parents: ProvenanceEnvelope[],
  capturedAt = Date.now(),
): ProvenanceEnvelope {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    id: `prov_artifact_${id}`,
    origin: "generated_derivative",
    authority: "evidence_only",
    identity: { label },
    integrity: {
      capturedAt,
      state: "unverified",
      transforms: parents.length > 0 ? ["summarized"] : [],
    },
    lineage: { parentIds: parents.map((parent) => parent.id) },
  };
}

export function memoryRecordProvenance(
  id: string,
  label: string,
  parents: ProvenanceEnvelope[] = [],
  capturedAt = Date.now(),
): ProvenanceEnvelope {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    id: `prov_memory_${id}`,
    origin: "memory",
    authority: "evidence_only",
    identity: { label, locator: id },
    integrity: {
      capturedAt,
      state: "unverified",
      transforms: parents.length > 0 ? ["summarized"] : [],
    },
    lineage: {
      parentIds: Array.from(new Set(parents.map((parent) => parent.id))),
    },
  };
}

export function normalizeMessageProvenance(message: AgentMessage): AgentMessage {
  const toolCalls = message.toolCalls?.map((tool) => ({
    ...tool,
    provenance:
      tool.provenance ??
      unknownProvenance(tool.id, "Legacy tool result", message.timestamp),
  }));
  const withTools = { ...message, toolCalls };
  return {
    ...withTools,
    provenance:
      message.provenance ??
      (message.role === "user"
        ? unknownProvenance(message.id, "Legacy user message", message.timestamp)
        : unknownProvenance(message.id, "Legacy message", message.timestamp)),
  };
}

export function activeTurnEvidence(conversation: AgentConversation): ProvenanceEnvelope[] {
  let start = 0;
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    if (conversation.messages[index].role === "user") {
      start = index;
      break;
    }
  }
  const seen = new Set<string>();
  const result: ProvenanceEnvelope[] = [];
  for (const message of conversation.messages.slice(start)) {
    for (const provenance of message.evidence ?? []) {
      if (!seen.has(provenance.id)) {
        seen.add(provenance.id);
        result.push(provenance);
      }
    }
    for (const tool of message.toolCalls ?? []) {
      const provenance = tool.provenance;
      if (provenance && !seen.has(provenance.id)) {
        seen.add(provenance.id);
        result.push(provenance);
      }
    }
  }
  return result;
}

const TAINTING_ORIGINS = new Set<ProvenanceOrigin>([
  "remote_workspace",
  "web",
  "mcp",
  "imported_file",
  "memory",
  "agent",
  "generated_derivative",
  "unknown",
]);

export function taintingEvidence(conversation: AgentConversation): ProvenanceEnvelope[] {
  return activeTurnEvidence(conversation).filter(
    (source) =>
      source.authority === "evidence_only" && TAINTING_ORIGINS.has(source.origin),
  );
}

export function provenanceNeedsRiskGate(
  conversation: AgentConversation,
  tier: "read" | "edit_in_project" | "blocking",
): boolean {
  return tier !== "read" && taintingEvidence(conversation).length > 0;
}

export function displayOrigin(origin: ProvenanceOrigin): string {
  return origin.replaceAll("_", " ");
}

export function shouldDisplayProvenance(
  envelope: ProvenanceEnvelope,
): boolean {
  return (
    envelope.origin !== "user" &&
    envelope.origin !== "local_workspace" &&
    envelope.origin !== "generated_derivative"
  );
}
