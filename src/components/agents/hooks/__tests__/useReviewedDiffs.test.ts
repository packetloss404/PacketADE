/**
 * P1-7 finalize: the Diff-tab "unreviewed" badge must only count tool calls
 * the user can actually clear. The badge's sole clear mechanism is selecting
 * a file in the Diff tab's list, and that list comes from
 * `aggregateWriteFiles` — so calls whose paths never materialize into that
 * list (Codex path-only apply_patch descriptors, Edit chains with no
 * recorded baseline) must not count. Regression guard for the permanent
 * "N unreviewed" badge over an empty file list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentConversation,
  AgentToolCall,
} from "@/types/agent-conversation";

// collectReviewableWriteCalls is pure over lib helpers + the baseline store;
// stub the task store so importing the hook module doesn't drag the full
// store (tauri IPC wiring) into this unit test.
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: vi.fn(),
}));

import { collectReviewableWriteCalls } from "@/components/agents/hooks/useReviewedDiffs";
import { useEditBaselineStore } from "@/stores/editBaselineStore";

function makeCall(
  id: string,
  name: string,
  input: unknown,
): AgentToolCall {
  return { id, name, status: "done", input: input as string };
}

function makeConversation(
  id: string,
  toolCalls: AgentToolCall[],
): AgentConversation {
  return {
    id,
    title: "Review badge",
    agent: "api-claude",
    projectPath: "/proj",
    status: "idle",
    messages: [
      {
        id: "msg-1",
        role: "assistant",
        content: "",
        timestamp: 1,
        toolCalls,
      },
    ],
    sessionId: id,
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
  };
}

beforeEach(() => {
  useEditBaselineStore.setState({
    byConversation: new Map(),
    byToolCall: new Map(),
  });
});

describe("collectReviewableWriteCalls", () => {
  it("excludes Codex path-only apply_patch calls (no permanent badge over an empty list)", () => {
    const conv = makeConversation("conv-cx", [
      makeCall(
        "tc-1",
        "apply_patch",
        JSON.stringify({
          type: "file_change",
          changes: [{ path: "src/a.ts", kind: "update" }],
        }),
      ),
    ]);
    expect(collectReviewableWriteCalls(conv)).toEqual([]);
  });

  it("counts Write calls and relativizes their absolute Claude Code paths", () => {
    const conv = makeConversation("conv-cc", [
      makeCall(
        "tc-1",
        "Write",
        JSON.stringify({ file_path: "/proj/src/a.ts", content: "body\n" }),
      ),
    ]);
    expect(collectReviewableWriteCalls(conv)).toEqual([
      { id: "tc-1", path: "src/a.ts" },
    ]);
  });

  it("excludes an Edit chain with no recorded baseline, includes it once one lands", () => {
    const conv = makeConversation("conv-ed", [
      makeCall(
        "tc-1",
        "Edit",
        JSON.stringify({
          file_path: "/proj/src/b.ts",
          old_string: "old",
          new_string: "new",
        }),
      ),
    ]);
    // No baseline (e.g. after app restart): the Diff tab's list omits the
    // path, so the badge must not count the call.
    expect(collectReviewableWriteCalls(conv)).toEqual([]);

    useEditBaselineStore
      .getState()
      .recordBaseline("conv-ed", "src/b.ts", "old content", "tc-1");
    expect(collectReviewableWriteCalls(conv)).toEqual([
      { id: "tc-1", path: "src/b.ts" },
    ]);
  });

  it("keeps only the materializable paths of a multi-file apply_patch envelope", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "*** Update File: src/existing.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const conv = makeConversation("conv-mx", [
      makeCall("tc-1", "apply_patch", JSON.stringify({ patch })),
    ]);
    // The Add File section materializes (full content in the transcript);
    // the Update File section is path-only and stays uncounted.
    expect(collectReviewableWriteCalls(conv)).toEqual([
      { id: "tc-1", path: "src/new.ts" },
    ]);
  });

  it("returns [] for a missing conversation", () => {
    expect(collectReviewableWriteCalls(undefined)).toEqual([]);
  });
});
