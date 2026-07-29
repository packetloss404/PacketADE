import {
  relevanceScores,
  type ContextItem,
} from "@/stores/memoryStore";
import type { ProjectMemoryNote } from "@/types/project-memory";

export type MemorySourceFilter = "all" | "global" | "project";

export interface UnifiedMemoryResult {
  id: string;
  source: "global" | "project";
  kind: ContextItem["kind"] | "project_note";
  title: string;
  reason: string;
  score: number;
  provenanceIds: string[];
}

export function unifiedMemoryResults(
  query: string,
  globalItems: ContextItem[],
  projectNotes: ProjectMemoryNote[],
  options: { source?: MemorySourceFilter; maxChars?: number } = {},
): UnifiedMemoryResult[] {
  const source = options.source ?? "all";
  const candidates: Array<{
    result: Omit<UnifiedMemoryResult, "score">;
    text: string;
  }> = [];
  if (source !== "project") {
    for (const item of globalItems) {
      candidates.push({
        result: {
          id: `global:${item.id}`,
          source: "global",
          kind: item.kind,
          title: item.title,
          reason: item.reason,
          provenanceIds: [],
        },
        text: item.title,
      });
    }
  }
  if (source !== "global") {
    for (const note of projectNotes) {
      if (note.metadata.archived) continue;
      candidates.push({
        result: {
          id: `project:${note.metadata.id}`,
          source: "project",
          kind: "project_note",
          title: note.metadata.title,
          reason: `${note.relativePath} · project Markdown`,
          provenanceIds: note.metadata.provenanceIds,
        },
        text: `${note.metadata.title}\n${note.body}\n${note.metadata.tags.join(" ")}`,
      });
    }
  }
  const scores = relevanceScores(
    query,
    candidates.map((candidate) => candidate.text),
  );
  const seen = new Set<string>();
  const ranked = candidates
    .map((candidate, index) => ({
      ...candidate.result,
      score: scores[index],
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.source.localeCompare(right.source) ||
        left.title.localeCompare(right.title),
    )
    .filter((candidate) => {
      const key = candidate.title.trim().toLowerCase();
      return !seen.has(key) && Boolean(seen.add(key));
    });

  const maxChars = Math.min(8_000, Math.max(200, options.maxChars ?? 2_400));
  const result: UnifiedMemoryResult[] = [];
  let used = 0;
  for (const candidate of ranked) {
    const cost = candidate.title.length + candidate.reason.length;
    if (used + cost > maxChars) break;
    result.push(candidate);
    used += cost;
  }
  return result;
}
