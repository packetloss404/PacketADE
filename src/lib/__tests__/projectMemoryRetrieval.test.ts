import { describe, expect, it } from "vitest";
import { unifiedMemoryResults } from "@/lib/projectMemoryRetrieval";
import type { ProjectMemoryNote } from "@/types/project-memory";

function note(
  id: string,
  title: string,
  body: string,
  provenanceIds: string[] = [],
): ProjectMemoryNote {
  return {
    metadata: {
      schemaVersion: 1,
      id,
      title,
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      tags: [],
      provenanceIds,
    },
    body,
    revision: id,
    relativePath: `${id}.md`,
    outboundIds: [],
    backlinkIds: [],
    brokenLinks: [],
    orphaned: true,
  };
}

describe("unified project/global memory retrieval", () => {
  it("ranks both sources, dedupes titles, and preserves provenance refs", () => {
    const results = unifiedMemoryResults(
      "ssh authentication",
      [
        {
          id: "g1",
          kind: "pattern",
          title: "SSH authentication uses pinned host keys",
          timestamp: 1,
          reason: "learned",
        },
      ],
      [
        note(
          "p1",
          "SSH troubleshooting",
          "Authentication uses the keyring",
          ["prov-1"],
        ),
        note("p2", "SSH authentication uses pinned host keys", "duplicate"),
      ],
    );
    expect(results.map((result) => result.source)).toContain("global");
    expect(results.map((result) => result.source)).toContain("project");
    expect(
      results.filter(
        (result) => result.title === "SSH authentication uses pinned host keys",
      ),
    ).toHaveLength(1);
    expect(results.find((result) => result.id === "project:p1")?.provenanceIds).toEqual([
      "prov-1",
    ]);
  });

  it("honors source and context-budget bounds", () => {
    const results = unifiedMemoryResults(
      "database",
      [],
      [
        note("p1", "Database one", "database"),
        note("p2", "Database two", "database"),
      ],
      { source: "project", maxChars: 200 },
    );
    expect(results.every((result) => result.source === "project")).toBe(true);
    expect(
      results.reduce(
        (total, result) => total + result.title.length + result.reason.length,
        0,
      ),
    ).toBeLessThanOrEqual(200);
  });
});
