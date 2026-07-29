import { describe, expect, it } from "vitest";
import {
  alreadyCaptured,
  buildProjectMemoryCapture,
  redactProjectMemoryCapture,
} from "@/lib/projectMemoryCapture";
import { toolResultProvenance } from "@/lib/provenance";

describe("project-memory capture", () => {
  it("redacts secrets and stores only provenance references", () => {
    const source = toolResultProvenance({
      toolId: "web",
      name: "web_fetch",
      content: "raw source",
    });
    const capture = buildProjectMemoryCapture({
      title: "Finding",
      body: "api_key=abcdefghijklmnop and ghp_secretcanary123",
      provenance: [source],
    });
    expect(capture.body).not.toContain("abcdefghijklmnop");
    expect(capture.body).not.toContain("ghp_secretcanary123");
    expect(capture.provenanceIds).toEqual([source.id]);
    expect(JSON.stringify(capture)).not.toContain("raw source");
  });

  it("detects idempotent captures by provenance reference", () => {
    expect(
      alreadyCaptured(
        [
          {
            metadata: {
              schemaVersion: 1,
              id: "n1",
              title: "Note",
              createdAt: 1,
              updatedAt: 1,
              archived: false,
              tags: [],
              provenanceIds: ["p1"],
            },
            body: "",
            revision: "r",
            relativePath: "n.md",
            outboundIds: [],
            backlinkIds: [],
            brokenLinks: [],
            orphaned: true,
          },
        ],
        ["p1"],
      ),
    ).toBe(true);
  });

  it("redacts private key blocks", () => {
    expect(
      redactProjectMemoryCapture(
        "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      ),
    ).toBe("[REDACTED]");
  });
});
