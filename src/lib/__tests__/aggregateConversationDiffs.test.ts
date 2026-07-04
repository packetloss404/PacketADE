import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentConversation,
  AgentToolCall,
} from "@/types/agent-conversation";

const readFileForDiffMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  readFileForDiff: readFileForDiffMock,
}));

import { aggregateConversationDiffs } from "@/lib/aggregateConversationDiffs";
import { useEditBaselineStore } from "@/stores/editBaselineStore";

function makeCall(
  id: string,
  name: string,
  input: unknown,
): AgentToolCall {
  return { id, name, status: "done", input: input as string };
}

function makeConversation(toolCalls: AgentToolCall[]): AgentConversation {
  return {
    id: "conv-1",
    title: "t",
    agent: "api-claude",
    projectPath: "/proj",
    status: "idle",
    messages: [
      { id: "m1", role: "user", content: "go", timestamp: 1 },
      { id: "m2", role: "assistant", content: "", timestamp: 2, toolCalls },
    ],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
  };
}

describe("aggregateConversationDiffs (P1-7 baselines)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditBaselineStore.setState({
      byConversation: new Map(),
      byToolCall: new Map(),
    });
  });

  it("diffs against the recorded baseline, NOT live disk, after apply (kills the +0/-0 degradation)", async () => {
    const proposed = "line one\nline two changed\nline three\n";
    const conv = makeConversation([
      makeCall(
        "tc-1",
        "write_file",
        JSON.stringify({ path: "src/a.ts", content: proposed }),
      ),
    ]);
    // Baseline recorded at edit time (pre-apply content).
    useEditBaselineStore
      .getState()
      .recordBaseline(
        "conv-1",
        "src/a.ts",
        "line one\nline two\nline three\n",
        "tc-1",
      );
    // The edit has APPLIED: live disk now matches the proposed content —
    // the pre-P1-7 pipeline would report +0/-0 here.
    readFileForDiffMock.mockResolvedValue(proposed);

    const result = await aggregateConversationDiffs(conv);
    expect(result.fileCount).toBe(1);
    expect(result.totalAdds).toBe(1);
    expect(result.totalDels).toBe(1);
    expect(result.perFile).toEqual([
      { path: "src/a.ts", adds: 1, dels: 1, isNew: false },
    ]);
    // Baseline present → the "before" never touches disk.
    expect(readFileForDiffMock).not.toHaveBeenCalled();
  });

  it("treats a null baseline as a new file (all lines added)", async () => {
    const conv = makeConversation([
      makeCall(
        "tc-1",
        "Write",
        JSON.stringify({ file_path: "src/new.ts", content: "a\nb\n" }),
      ),
    ]);
    useEditBaselineStore
      .getState()
      .recordBaseline("conv-1", "src/new.ts", null, "tc-1");

    const result = await aggregateConversationDiffs(conv);
    expect(result.perFile).toEqual([
      { path: "src/new.ts", adds: 3, dels: 0, isNew: true },
    ]);
  });

  it("materializes Claude Code Edit chains from the baseline (transcript layer fires for Write/Edit)", async () => {
    const conv = makeConversation([
      makeCall(
        "tc-1",
        "Edit",
        JSON.stringify({
          file_path: "src/b.ts",
          old_string: "old value",
          new_string: "new value",
        }),
      ),
    ]);
    useEditBaselineStore
      .getState()
      .recordBaseline("conv-1", "src/b.ts", "const x = 'old value';\n", "tc-1");

    const result = await aggregateConversationDiffs(conv);
    expect(result.fileCount).toBe(1);
    expect(result.perFile).toEqual([
      { path: "src/b.ts", adds: 1, dels: 1, isNew: false },
    ]);
    expect(readFileForDiffMock).not.toHaveBeenCalled();
  });

  it("falls back to disk for the applied 'after' of Codex apply_patch edits", async () => {
    const conv = makeConversation([
      makeCall(
        "tc-1",
        "apply_patch",
        JSON.stringify({
          type: "file_change",
          changes: [{ path: "src/c.ts", kind: "update" }],
        }),
      ),
    ]);
    useEditBaselineStore
      .getState()
      .recordBaseline("conv-1", "src/c.ts", "before\n", "tc-1");
    // Applied result on disk.
    readFileForDiffMock.mockResolvedValue("before\nadded\n");

    const result = await aggregateConversationDiffs(conv);
    expect(result.perFile).toEqual([
      { path: "src/c.ts", adds: 1, dels: 0, isNew: false },
    ]);
    expect(readFileForDiffMock).toHaveBeenCalledWith("/proj", "src/c.ts");
  });

  it("falls back to disk for the 'before' when no baseline was recorded (legacy behavior)", async () => {
    const conv = makeConversation([
      makeCall(
        "tc-1",
        "write_file",
        JSON.stringify({ path: "src/d.ts", content: "one\ntwo\n" }),
      ),
    ]);
    readFileForDiffMock.mockResolvedValue("one\n");

    const result = await aggregateConversationDiffs(conv);
    expect(result.perFile).toEqual([
      { path: "src/d.ts", adds: 1, dels: 0, isNew: false },
    ]);
  });

  it("relativizes absolute Claude Code paths before touching disk or baselines", async () => {
    // Claude Code's Write carries an absolute file_path; read_file_for_diff
    // hard-rejects absolute rel_path, so the aggregation must key and read
    // project-relative.
    const conv = makeConversation([
      makeCall(
        "tc-1",
        "Write",
        JSON.stringify({ file_path: "/proj/src/f.ts", content: "one\ntwo\n" }),
      ),
    ]);
    readFileForDiffMock.mockResolvedValue("one\n");

    const result = await aggregateConversationDiffs(conv);
    expect(result.perFile).toEqual([
      { path: "src/f.ts", adds: 1, dels: 0, isNew: false },
    ]);
    expect(readFileForDiffMock).toHaveBeenCalledWith("/proj", "src/f.ts");

    // Baselines recorded from runtime events land under the same relative
    // key, so the applied edit keeps its true counts without a disk read.
    readFileForDiffMock.mockClear();
    useEditBaselineStore
      .getState()
      .recordBaseline("conv-1", "src/f.ts", "one\n", "tc-1");
    const withBaseline = await aggregateConversationDiffs(conv);
    expect(withBaseline.perFile).toEqual([
      { path: "src/f.ts", adds: 1, dels: 0, isNew: false },
    ]);
    expect(readFileForDiffMock).not.toHaveBeenCalled();
  });

  it("skips files whose disk read fails, keeping a zero-count row", async () => {
    const conv = makeConversation([
      makeCall(
        "tc-1",
        "write_file",
        JSON.stringify({ path: "src/e.ts", content: "x\n" }),
      ),
    ]);
    readFileForDiffMock.mockRejectedValue(new Error("io"));

    const result = await aggregateConversationDiffs(conv);
    expect(result.perFile).toEqual([
      { path: "src/e.ts", adds: 0, dels: 0, isNew: false },
    ]);
    expect(result.totalAdds).toBe(0);
  });
});
