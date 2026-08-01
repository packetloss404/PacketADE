import { describe, expect, it } from "vitest";
import {
  applyEditReplacements,
  isEditToolCall,
  isEditToolName,
  materializeEdits,
  parseEditToolCalls,
  parseToolInput,
  parseWriteFileInput,
  toProjectRelativePath,
} from "@/lib/parseToolInput";
import type { AgentToolCall } from "@/types/agent-conversation";

function makeCall(input: unknown): AgentToolCall {
  return {
    id: "tc-1",
    name: "write_file",
    status: "done",
    input: input as string,
  };
}

function makeNamedCall(name: string, input: unknown): AgentToolCall {
  return {
    id: "tc-1",
    name,
    status: "done",
    input: input as string,
  };
}

describe("parseToolInput", () => {
  it("decodes a JSON-string input (the wire shape)", () => {
    expect(parseToolInput('{"path":"a.ts","content":"x"}')).toEqual({
      path: "a.ts",
      content: "x",
    });
  });

  it("passes through an already-parsed object (replay shape)", () => {
    const obj = { path: "a.ts", content: "x" };
    expect(parseToolInput(obj)).toBe(obj);
  });

  it("returns null for null/undefined", () => {
    expect(parseToolInput(null)).toBeNull();
    expect(parseToolInput(undefined)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseToolInput("ls -la")).toBeNull();
    expect(parseToolInput("")).toBeNull();
  });

  it("returns null for JSON that decodes to a non-object", () => {
    expect(parseToolInput('"just a string"')).toBeNull();
    expect(parseToolInput("42")).toBeNull();
    expect(parseToolInput("true")).toBeNull();
  });
});

describe("parseWriteFileInput", () => {
  it("extracts path+content from a JSON-string input", () => {
    expect(
      parseWriteFileInput(
        makeCall(JSON.stringify({ path: "src/a.ts", content: "hi\n" })),
      ),
    ).toEqual({ path: "src/a.ts", content: "hi\n" });
  });

  it("extracts path+content from an object input", () => {
    expect(
      parseWriteFileInput(makeCall({ path: "src/a.ts", content: "hi\n" })),
    ).toEqual({ path: "src/a.ts", content: "hi\n" });
  });

  it("accepts the file_path alias", () => {
    expect(
      parseWriteFileInput(
        makeCall(JSON.stringify({ file_path: "src/a.ts", content: "" })),
      ),
    ).toEqual({ path: "src/a.ts", content: "" });
  });

  it("returns null when path or content is missing", () => {
    expect(parseWriteFileInput(makeCall('{"content":"x"}'))).toBeNull();
    expect(parseWriteFileInput(makeCall('{"path":"a.ts"}'))).toBeNull();
    expect(parseWriteFileInput(makeCall(undefined))).toBeNull();
    expect(parseWriteFileInput(makeCall("garbage"))).toBeNull();
  });
});

/**
 * P1-7: one normalization map per provider tool name. Each suite feeds the
 * wire shape (JSON string) that provider's sidecar actually delivers.
 */
describe("parseEditToolCalls", () => {
  it("recognizes every provider's edit tool names and nothing else", () => {
    for (const name of [
      "write_file",
      "edit_file",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "apply_patch",
    ]) {
      expect(isEditToolName(name)).toBe(true);
    }
    expect(isEditToolName("Read")).toBe(false);
    expect(isEditToolName("bash")).toBe(false);
    expect(isEditToolName("Bash")).toBe(false);
    expect(
      parseEditToolCalls(makeNamedCall("Read", '{"file_path":"a.ts"}')),
    ).toEqual([]);
  });

  it("maps write_file (in-process / openai-agents) to a full-content edit", () => {
    expect(
      parseEditToolCalls(
        makeNamedCall(
          "write_file",
          JSON.stringify({ path: "src/a.ts", content: "hi\n" }),
        ),
      ),
    ).toEqual([{ path: "src/a.ts", after: "hi\n" }]);
  });

  it("maps edit_file (in-process targeted edit) to a replacement chain", () => {
    expect(
      parseEditToolCalls(
        makeNamedCall(
          "edit_file",
          JSON.stringify({
            path: "src/a.ts",
            old_string: "  const x = 1;",
            new_string: "  const x = 2;",
          }),
        ),
      ),
    ).toEqual([
      {
        path: "src/a.ts",
        replacements: [
          {
            oldString: "  const x = 1;",
            newString: "  const x = 2;",
            replaceAll: false,
          },
        ],
      },
    ]);
  });

  it("carries edit_file's replace_all flag through to the descriptor", () => {
    const [edit] = parseEditToolCalls(
      makeNamedCall(
        "edit_file",
        JSON.stringify({
          path: "src/a.ts",
          old_string: "a",
          new_string: "b",
          replace_all: true,
        }),
      ),
    );
    expect(edit.replacements?.[0].replaceAll).toBe(true);
  });

  it("materializes an edit_file replacement on top of a baseline", () => {
    const edits = parseEditToolCalls(
      makeNamedCall(
        "edit_file",
        JSON.stringify({
          path: "src/a.ts",
          old_string: "  const x = 1;",
          new_string: "  const x = 2;",
        }),
      ),
    );
    expect(materializeEdits(edits, "top\n  const x = 1;\nbottom\n")).toBe(
      "top\n  const x = 2;\nbottom\n",
    );
    // No baseline: the transcript alone can't reproduce the result.
    expect(materializeEdits(edits, null)).toBeNull();
  });

  it("maps Claude Code Write (string and object inputs)", () => {
    const expected = [{ path: "/abs/src/a.ts", after: "body\n" }];
    expect(
      parseEditToolCalls(
        makeNamedCall(
          "Write",
          JSON.stringify({ file_path: "/abs/src/a.ts", content: "body\n" }),
        ),
      ),
    ).toEqual(expected);
    expect(
      parseEditToolCalls(
        makeNamedCall("Write", { file_path: "/abs/src/a.ts", content: "body\n" }),
      ),
    ).toEqual(expected);
  });

  it("maps Claude Code Edit to a replacement descriptor", () => {
    expect(
      parseEditToolCalls(
        makeNamedCall(
          "Edit",
          JSON.stringify({
            file_path: "/abs/b.ts",
            old_string: "foo",
            new_string: "bar",
            replace_all: true,
          }),
        ),
      ),
    ).toEqual([
      {
        path: "/abs/b.ts",
        replacements: [{ oldString: "foo", newString: "bar", replaceAll: true }],
      },
    ]);
  });

  it("maps Claude Code MultiEdit to an ordered replacement chain", () => {
    expect(
      parseEditToolCalls(
        makeNamedCall(
          "MultiEdit",
          JSON.stringify({
            file_path: "/abs/c.ts",
            edits: [
              { old_string: "a", new_string: "b" },
              { old_string: "c", new_string: "d", replace_all: true },
            ],
          }),
        ),
      ),
    ).toEqual([
      {
        path: "/abs/c.ts",
        replacements: [
          { oldString: "a", newString: "b", replaceAll: false },
          { oldString: "c", newString: "d", replaceAll: true },
        ],
      },
    ]);
  });

  it("maps Claude Code NotebookEdit via notebook_path/new_source", () => {
    expect(
      parseEditToolCalls(
        makeNamedCall(
          "NotebookEdit",
          JSON.stringify({ notebook_path: "/abs/n.ipynb", new_source: "x = 1" }),
        ),
      ),
    ).toEqual([{ path: "/abs/n.ipynb", after: "x = 1" }]);
  });

  it("maps a Codex apply_patch envelope to one edit per file", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "+export const b = 2;",
      "*** Update File: src/existing.ts",
      "@@",
      "-old line",
      "+new line",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    expect(
      parseEditToolCalls(
        makeNamedCall("apply_patch", JSON.stringify({ patch })),
      ),
    ).toEqual([
      { path: "src/new.ts", after: "export const a = 1;\nexport const b = 2;" },
      { path: "src/existing.ts" },
      { path: "src/dead.ts", after: "" },
    ]);
  });

  it("maps a Codex file_change item's changes list (path-only edits)", () => {
    // The Codex CLI 0.135+ item shape that crosses the wire on tool_start.
    const item = {
      id: "item_3",
      type: "file_change",
      status: "in_progress",
      changes: [
        { path: "src/a.ts", kind: "update" },
        { path: "src/b.ts", kind: "delete" },
      ],
    };
    expect(
      parseEditToolCalls(makeNamedCall("apply_patch", JSON.stringify(item))),
    ).toEqual([{ path: "src/a.ts" }, { path: "src/b.ts", after: "" }]);
  });

  it("returns [] for malformed inputs instead of throwing", () => {
    expect(parseEditToolCalls(makeNamedCall("Write", "garbage"))).toEqual([]);
    expect(parseEditToolCalls(makeNamedCall("Edit", '{"file_path":"a"}'))).toEqual([]);
    expect(parseEditToolCalls(makeNamedCall("MultiEdit", '{"file_path":"a","edits":[]}'))).toEqual([]);
    expect(parseEditToolCalls(makeNamedCall("apply_patch", '{"weird":true}'))).toEqual([]);
    expect(parseEditToolCalls(makeNamedCall("write_file", undefined))).toEqual([]);
  });

  it("relativizes absolute in-project paths when projectPath is given (read_file_for_diff rejects absolute rel_path)", () => {
    expect(
      parseEditToolCalls(
        makeNamedCall(
          "Write",
          JSON.stringify({ file_path: "/proj/src/a.ts", content: "x\n" }),
        ),
        "/proj",
      ),
    ).toEqual([{ path: "src/a.ts", after: "x\n" }]);
    // apply_patch descriptors relativize too (Codex may report absolute paths).
    expect(
      parseEditToolCalls(
        makeNamedCall(
          "apply_patch",
          JSON.stringify({
            type: "file_change",
            changes: [{ path: "/proj/src/b.ts", kind: "update" }],
          }),
        ),
        "/proj",
      ),
    ).toEqual([{ path: "src/b.ts" }]);
    // Already-relative and out-of-project paths pass through unchanged.
    expect(
      parseEditToolCalls(
        makeNamedCall(
          "write_file",
          JSON.stringify({ path: "src/c.ts", content: "" }),
        ),
        "/proj",
      ),
    ).toEqual([{ path: "src/c.ts", after: "" }]);
    expect(
      parseEditToolCalls(
        makeNamedCall(
          "Write",
          JSON.stringify({ file_path: "/elsewhere/d.ts", content: "" }),
        ),
        "/proj",
      ),
    ).toEqual([{ path: "/elsewhere/d.ts", after: "" }]);
  });

  it("isEditToolCall requires a parseable path, not just the tool name", () => {
    expect(
      isEditToolCall(
        makeNamedCall("Write", '{"file_path":"a.ts","content":""}'),
      ),
    ).toBe(true);
    expect(isEditToolCall(makeNamedCall("Write", "garbage"))).toBe(false);
    expect(isEditToolCall(makeNamedCall("bash", '{"command":"ls"}'))).toBe(false);
  });
});

describe("toProjectRelativePath", () => {
  it("strips the project prefix from absolute in-project paths", () => {
    expect(toProjectRelativePath("/proj/src/a.ts", "/proj")).toBe("src/a.ts");
    expect(toProjectRelativePath("/proj/src/a.ts", "/proj/")).toBe("src/a.ts");
  });

  it("handles Windows separators on either side", () => {
    expect(
      toProjectRelativePath("D:\\projects\\example\\src\\a.ts", "D:/projects/example"),
    ).toBe("src/a.ts");
    expect(
      toProjectRelativePath("D:/projects/example/src/a.ts", "D:\\projects\\example"),
    ).toBe("src/a.ts");
  });

  it("passes through relative, out-of-project, and prefix-lookalike paths", () => {
    expect(toProjectRelativePath("src/a.ts", "/proj")).toBe("src/a.ts");
    expect(toProjectRelativePath("/other/src/a.ts", "/proj")).toBe(
      "/other/src/a.ts",
    );
    // "/proj-sibling" must not match the "/proj" root.
    expect(toProjectRelativePath("/proj-sibling/a.ts", "/proj")).toBe(
      "/proj-sibling/a.ts",
    );
    expect(toProjectRelativePath("/proj/src/a.ts", undefined)).toBe(
      "/proj/src/a.ts",
    );
  });
});

describe("applyEditReplacements / materializeEdits", () => {
  it("applies single and replace-all replacements like the SDK's Edit tool", () => {
    expect(
      applyEditReplacements("a b a", [
        { oldString: "a", newString: "x", replaceAll: false },
      ]),
    ).toBe("x b a");
    expect(
      applyEditReplacements("a b a", [
        { oldString: "a", newString: "x", replaceAll: true },
      ]),
    ).toBe("x b x");
    // Unmatched / empty oldString leave content unchanged.
    expect(
      applyEditReplacements("abc", [
        { oldString: "zzz", newString: "x", replaceAll: false },
        { oldString: "", newString: "x", replaceAll: true },
      ]),
    ).toBe("abc");
  });

  it("replays a mixed chain on a baseline (write then edit)", () => {
    expect(
      materializeEdits(
        [
          { path: "a.ts", after: "one\ntwo\n" },
          {
            path: "a.ts",
            replacements: [{ oldString: "two", newString: "2", replaceAll: false }],
          },
        ],
        null,
      ),
    ).toBe("one\n2\n");
  });

  it("materializes replacements from a recorded baseline", () => {
    expect(
      materializeEdits(
        [
          {
            path: "a.ts",
            replacements: [{ oldString: "old", newString: "new", replaceAll: false }],
          },
        ],
        "old content",
      ),
    ).toBe("new content");
  });

  it("returns null when the chain is not reproducible from the transcript", () => {
    // Replacement with no baseline.
    expect(
      materializeEdits(
        [{ path: "a.ts", replacements: [{ oldString: "a", newString: "b", replaceAll: false }] }],
        null,
      ),
    ).toBeNull();
    // Path-only descriptor (Codex Update File).
    expect(materializeEdits([{ path: "a.ts" }], "content")).toBeNull();
  });
});
