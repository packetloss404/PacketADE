import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { parseWriteFile } from "@/lib/diffUtils";
import { logSwallowed } from "@/lib/logSwallowed";

/**
 * Persistent storage key for the per-conversation reviewed-tool-call sets.
 * Shape on disk: `Record<conversationId, string[]>` — each string is an
 * `AgentToolCall.id` that the user has acknowledged (either by selecting
 * the file in the Diff tab or by applying / rejecting its hunks).
 *
 * The set grows monotonically as conversations accumulate `write_file`
 * tool calls; orphan entries (after a conversation is deleted) are bounded
 * by the conversation's lifetime — a P3 cleanup pass is acceptable.
 */
const STORAGE_KEY = "packetade:diff-reviewed-tools-v1";

type ReviewedMap = Record<string, string[]>;

function readPersistedMap(): ReviewedMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: ReviewedMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        out[k] = v.filter((x): x is string => typeof x === "string");
      }
    }
    return out;
  } catch (err) {
    logSwallowed("useReviewedDiffs.readPersistedMap")(err);
    return {};
  }
}

function persistMap(map: ReviewedMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (err) {
    logSwallowed("useReviewedDiffs.persistMap")(err);
  }
}

/**
 * `cross-tab/cross-hook` shared state. All hook instances read from a
 * single in-memory mirror so two mounts of the inspector + diff body for
 * the same conversation stay in sync. `subscribers` is a Set of
 * notification callbacks; each hook instance subscribes on mount and
 * re-renders when any other instance marks a tool call reviewed.
 */
let memoryMap: ReviewedMap | null = null;
const subscribers = new Set<() => void>();

function getMap(): ReviewedMap {
  if (memoryMap === null) memoryMap = readPersistedMap();
  return memoryMap;
}

function setMap(next: ReviewedMap): void {
  memoryMap = next;
  persistMap(next);
  for (const fn of subscribers) fn();
}

interface WriteCall {
  id: string;
  path: string;
}

/**
 * Walk a conversation's messages and return every `write_file` tool call as
 * `{ id, path }`. Order matches chronological message order.
 */
function collectWriteCalls(
  conversation:
    | {
        messages: { toolCalls?: { id: string; name: string; input?: unknown }[] }[];
      }
    | undefined,
): WriteCall[] {
  const out: WriteCall[] = [];
  if (!conversation) return out;
  for (const msg of conversation.messages) {
    if (!msg.toolCalls?.length) continue;
    for (const tc of msg.toolCalls) {
      const parsed = parseWriteFile(tc as Parameters<typeof parseWriteFile>[0]);
      if (!parsed) continue;
      out.push({ id: tc.id, path: parsed.path });
    }
  }
  return out;
}

export interface UseReviewedDiffsReturn {
  /** Number of `write_file` tool calls the user has not yet acknowledged. */
  unreviewedCount: number;
  /**
   * Mark every `write_file` tool call whose payload targets `path` as
   * reviewed. The reviewed-set lives in localStorage under
   * {@link STORAGE_KEY}.
   */
  markReviewed: (path: string) => void;
  /** Mark a specific tool-call id reviewed (apply/reject paths). */
  markToolCallReviewed: (toolCallId: string) => void;
}

/**
 * Tracks which `write_file` tool calls in a conversation the user has
 * "reviewed". Persisted per-conversation in localStorage so the badge
 * count survives reloads.
 *
 * Returns `{ unreviewedCount, markReviewed, markToolCallReviewed }`.
 * `unreviewedCount` is `0` when the conversation is missing or has no
 * `write_file` tool calls at all.
 */
export function useReviewedDiffs(
  conversationId: string | null | undefined,
): UseReviewedDiffsReturn {
  const conversation = useAgentTaskStore((s) =>
    conversationId ? s.conversations.find((c) => c.id === conversationId) : undefined,
  );

  // Local tick so this hook re-renders whenever the shared map changes
  // (e.g., another component on the same screen calls `markReviewed`).
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }, []);

  const writeCalls = useMemo(
    () => collectWriteCalls(conversation),
    [conversation],
  );

  const reviewedSet = useMemo<Set<string>>(() => {
    if (!conversationId) return new Set();
    const ids = getMap()[conversationId] ?? [];
    return new Set(ids);
  }, [conversationId]);

  const unreviewedCount = useMemo(() => {
    if (writeCalls.length === 0) return 0;
    let n = 0;
    for (const c of writeCalls) if (!reviewedSet.has(c.id)) n += 1;
    return n;
  }, [writeCalls, reviewedSet]);

  const markToolCallReviewed = useCallback(
    (toolCallId: string) => {
      if (!conversationId) return;
      const map = getMap();
      const existing = new Set(map[conversationId] ?? []);
      if (existing.has(toolCallId)) return;
      existing.add(toolCallId);
      setMap({ ...map, [conversationId]: Array.from(existing) });
    },
    [conversationId],
  );

  const markReviewed = useCallback(
    (path: string) => {
      if (!conversationId) return;
      const matching = writeCalls.filter((c) => c.path === path).map((c) => c.id);
      if (matching.length === 0) return;
      const map = getMap();
      const existing = new Set(map[conversationId] ?? []);
      let changed = false;
      for (const id of matching) {
        if (!existing.has(id)) {
          existing.add(id);
          changed = true;
        }
      }
      if (!changed) return;
      setMap({ ...map, [conversationId]: Array.from(existing) });
    },
    [conversationId, writeCalls],
  );

  return { unreviewedCount, markReviewed, markToolCallReviewed };
}
