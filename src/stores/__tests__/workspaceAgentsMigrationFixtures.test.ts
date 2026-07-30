import { describe, expect, it } from "vitest";
import { normalizePanes } from "@/stores/workspaceStore";
import preConversationPanes from "./fixtures/workspaces-v07-pre-conversation-panes.json";
import conversationPanes from "./fixtures/workspaces-v09-conversation-panes.json";
import oldBinaryResave from "./fixtures/workspaces-old-binary-resave.json";
import type { Workspace } from "@/types/workspace";

function fixture(value: unknown): Workspace[] {
  return JSON.parse(JSON.stringify(value)) as Workspace[];
}

describe("WA4 saved-Workspace migration fixtures", () => {
  it("loads pre-conversation-pane layouts as terminal-only and clears stale process ids", () => {
    const [workspace] = normalizePanes(fixture(preConversationPanes));

    expect(workspace.agents).toEqual(["codex", "terminal"]);
    expect(workspace.panes.map((pane) => pane.kind)).toEqual(["terminal", "terminal"]);
    expect(workspace.panes.map((pane) => pane.sessionId)).toEqual([null, null]);
    expect((workspace.panes[1] as unknown as { legacyLayoutHint?: string }).legacyLayoutHint).toBe(
      "right",
    );
  });

  it("round-trips a mixed CLI/conversation layout with the same durable conversation ID", () => {
    const [workspace] = normalizePanes(fixture(conversationPanes));

    expect(workspace.panes).toHaveLength(2);
    expect(workspace.panes[0]).toMatchObject({
      id: "pane-packetcode",
      agentId: "packetcode",
      kind: "terminal",
    });
    expect(workspace.panes[1]).toMatchObject({
      id: "pane-conversation",
      kind: "conversation",
      conversationId: "conv-durable",
    });
  });

  it("degrades an old-binary re-save to a harmless terminal and leaves an auditable orphan wrapper", () => {
    const [workspace] = normalizePanes(fixture(oldBinaryResave));

    expect(workspace.origin).toBe("conversation");
    expect(workspace.panes[0]).toMatchObject({
      id: "pane-stripped",
      agentId: "terminal",
      kind: "terminal",
    });
    expect(workspace.panes[0]).not.toHaveProperty("conversationId");
    expect(workspace.panes.some((pane) => pane.kind === "conversation")).toBe(false);
  });

  it("is idempotent across repeated normalization passes", () => {
    const first = normalizePanes(fixture(conversationPanes));
    const second = normalizePanes(fixture(first));

    expect(second).toEqual(first);
  });
});
