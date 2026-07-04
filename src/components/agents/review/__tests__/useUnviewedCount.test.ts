/**
 * Diff-tab badge count (P1-8 successor to the useReviewedDiffs guard):
 * the badge must only count items the user can actually clear from the
 * review surface — files that materialize into `aggregateWriteFiles`'
 * reviewable list, plus gated edits awaiting a decision. Codex path-only
 * apply_patch descriptors and baseline-less Edit chains never render, so
 * they must not count (no permanent badge over an empty surface).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentConversation,
  AgentToolCall,
} from "@/types/agent-conversation";

// countUnviewedFiles is pure over lib helpers + the baseline store; stub
// the stores the hook half of the module drags in so importing it doesn't
// pull tauri IPC wiring into this unit test.
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: vi.fn(),
}));
vi.mock("@/stores/agentApprovalStore", () => ({
  EMPTY_PENDING_EDITS: [],
  useAgentApprovalStore: vi.fn(),
}));

import { countUnviewedFiles } from "@/components/agents/review/useUnviewedCount";
import { editSignature } from "@/stores/reviewStore";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { aggregateWriteFiles } from "@/lib/diffUtils";

function makeCall(id: string, name: string, input: unknown): AgentToolCall {
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

describe("countUnviewedFiles", () => {
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
    expect(countUnviewedFiles(conv, undefined, [])).toBe(0);
  });

  it("counts Write calls (relativized Claude Code paths) until marked Viewed", () => {
    const conv = makeConversation("conv-cc", [
      makeCall(
        "tc-1",
        "Write",
        JSON.stringify({ file_path: "/proj/src/a.ts", content: "body\n" }),
      ),
    ]);
    expect(countUnviewedFiles(conv, undefined, [])).toBe(1);

    // Marking the CURRENT signature viewed clears the badge…
    const entry = aggregateWriteFiles(conv).get("src/a.ts");
    expect(entry).toBeDefined();
    const sig = editSignature(entry!);
    expect(countUnviewedFiles(conv, { "src/a.ts": sig }, [])).toBe(0);
    // …but a stale signature (file edited again) does not.
    expect(countUnviewedFiles(conv, { "src/a.ts": "0:0" }, [])).toBe(1);
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
    // No baseline (e.g. after app restart): the surface omits the path,
    // so the badge must not count the call.
    expect(countUnviewedFiles(conv, undefined, [])).toBe(0);

    useEditBaselineStore
      .getState()
      .recordBaseline("conv-ed", "src/b.ts", "old content", "tc-1");
    expect(countUnviewedFiles(conv, undefined, [])).toBe(1);
  });

  it("counts pending edits once each, never double-counting their path", () => {
    const conv = makeConversation("conv-p", [
      makeCall(
        "tc-1",
        "write_file",
        JSON.stringify({ path: "src/a.ts", content: "body\n" }),
      ),
    ]);
    const pending = [
      { id: "edit-1", path: "src/a.ts", content: "body\n", before: "" },
    ];
    // The path appears both as a transcript file AND a pending edit —
    // one review item, one badge unit.
    expect(countUnviewedFiles(conv, undefined, pending)).toBe(1);
  });

  it("counts pending edits even with no conversation loaded", () => {
    expect(
      countUnviewedFiles(undefined, undefined, [
        { id: "edit-1", path: "src/x.ts", content: "x\n" },
      ]),
    ).toBe(1);
  });
});
