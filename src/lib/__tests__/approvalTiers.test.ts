import { describe, expect, it } from "vitest";
import {
  classifyToolTier,
  decideApprovalGate,
  isPathInProject,
  type ApprovalGateMode,
  type ApprovalTier,
} from "@/lib/approvalTiers";

const PROJ = "/Users/dev/proj";

describe("classifyToolTier — read/search tools never prompt", () => {
  it.each([
    // Claude Code SDK vocabulary
    "Read",
    "Glob",
    "Grep",
    "LS",
    "NotebookRead",
    "TodoWrite",
    "BashOutput",
    // in-process + openai-agents sidecar vocabulary
    "read_file",
    "list_directory",
    "grep",
  ])("classifies %s as read", (name) => {
    expect(classifyToolTier(name, "{}", PROJ)).toBe("read");
  });

  it("read classification does not depend on arguments parsing", () => {
    expect(classifyToolTier("Grep", "not json at all", PROJ)).toBe("read");
  });
});

describe("classifyToolTier — edits split on project containment", () => {
  it("Write with an absolute in-project file_path is edit_in_project", () => {
    const args = JSON.stringify({ file_path: `${PROJ}/src/a.ts`, content: "x" });
    expect(classifyToolTier("Write", args, PROJ)).toBe("edit_in_project");
  });

  it("Write outside the project is blocking", () => {
    const args = JSON.stringify({ file_path: "/etc/hosts", content: "pwn" });
    expect(classifyToolTier("Write", args, PROJ)).toBe("blocking");
  });

  it("Edit with an in-project path is edit_in_project", () => {
    const args = JSON.stringify({
      file_path: `${PROJ}/src/a.ts`,
      old_string: "a",
      new_string: "b",
    });
    expect(classifyToolTier("Edit", args, PROJ)).toBe("edit_in_project");
  });

  it("write_file with a relative path (cwd = project) is edit_in_project", () => {
    const args = JSON.stringify({ path: "src/a.ts", content: "x" });
    expect(classifyToolTier("write_file", args, PROJ)).toBe("edit_in_project");
  });

  it("edit_file with a relative in-project path is edit_in_project", () => {
    const args = JSON.stringify({
      path: "src/a.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(classifyToolTier("edit_file", args, PROJ)).toBe("edit_in_project");
  });

  it("edit_file that climbs out of the project is blocking", () => {
    const args = JSON.stringify({
      path: "../outside.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(classifyToolTier("edit_file", args, PROJ)).toBe("blocking");
  });

  it("relative paths that climb out via .. are blocking", () => {
    const args = JSON.stringify({ path: "../outside.ts", content: "x" });
    expect(classifyToolTier("write_file", args, PROJ)).toBe("blocking");
  });

  it("home-relative (~) paths are blocking", () => {
    const args = JSON.stringify({ file_path: "~/secrets.txt", content: "x" });
    expect(classifyToolTier("Write", args, PROJ)).toBe("blocking");
  });

  it("normalizes Windows separators against a Windows project root", () => {
    const args = JSON.stringify({
      file_path: "D:\\proj\\src\\a.ts",
      content: "x",
    });
    expect(classifyToolTier("Write", args, "D:/proj")).toBe("edit_in_project");
  });

  it("apply_patch envelope with only in-project files is edit_in_project", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Add File: src/b.ts",
      "+hello",
      "*** End Patch",
    ].join("\n");
    expect(classifyToolTier("apply_patch", patch, PROJ)).toBe("edit_in_project");
  });

  it("apply_patch envelope touching a file outside the project is blocking", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Update File: /etc/passwd",
      "*** End Patch",
    ].join("\n");
    expect(classifyToolTier("apply_patch", patch, PROJ)).toBe("blocking");
  });

  it("edit tools with no derivable path are blocking (conservative)", () => {
    expect(classifyToolTier("Write", "{}", PROJ)).toBe("blocking");
    expect(classifyToolTier("Write", "garbage", PROJ)).toBe("blocking");
  });

  it("falls back to the bare path field when the canonical parse is empty", () => {
    // Non-string `content` defeats the canonical Write descriptor, but the
    // named file still classifies by containment.
    const args = JSON.stringify({ file_path: `${PROJ}/src/a.ts`, content: 42 });
    expect(classifyToolTier("Write", args, PROJ)).toBe("edit_in_project");
  });
});

describe("classifyToolTier — everything else blocks", () => {
  it.each([
    ["bash", '{"command":"ls"}'],
    ["Bash", '{"command":"ls"}'],
    ["exec", '{"command":"ls"}'],
    ["WebFetch", '{"url":"https://example.com"}'],
    ["WebSearch", '{"query":"docs"}'],
    ["Task", '{"prompt":"do things"}'],
    ["mcp__github__create_issue", "{}"],
    ["unknown_tool", "{}"],
  ])("classifies %s as blocking", (name, args) => {
    expect(classifyToolTier(name, args, PROJ)).toBe("blocking");
  });
});

describe("isPathInProject", () => {
  it("accepts relative and project-rooted absolute paths", () => {
    expect(isPathInProject("src/a.ts", PROJ)).toBe(true);
    expect(isPathInProject(`${PROJ}/deep/nested/file.ts`, PROJ)).toBe(true);
  });

  it("rejects absolute paths outside the project", () => {
    expect(isPathInProject("/tmp/x", PROJ)).toBe(false);
    // A sibling directory sharing the project prefix must not pass.
    expect(isPathInProject(`${PROJ}-evil/x.ts`, PROJ)).toBe(false);
  });

  it("rejects .. traversal and UNC/drive-absolute paths", () => {
    expect(isPathInProject("src/../../x.ts", PROJ)).toBe(false);
    expect(isPathInProject("C:\\Windows\\system32", PROJ)).toBe(false);
    expect(isPathInProject("\\\\server\\share", PROJ)).toBe(false);
  });
});

describe("decideApprovalGate — the mode chip stays the source of truth", () => {
  const matrix: Array<[ApprovalGateMode, ApprovalTier, "auto_allow" | "prompt"]> = [
    // Default: reads and in-project edits auto-apply; blocking prompts.
    ["default", "read", "auto_allow"],
    ["default", "edit_in_project", "auto_allow"],
    ["default", "blocking", "prompt"],
    // Yolo is strictly more permissive than default.
    ["yolo", "read", "auto_allow"],
    ["yolo", "edit_in_project", "auto_allow"],
    ["yolo", "blocking", "prompt"],
    // Manual ("Ask for risky"): reads are never risky, edits ask.
    ["manual", "read", "auto_allow"],
    ["manual", "edit_in_project", "prompt"],
    ["manual", "blocking", "prompt"],
    // Plan and deny-risky keep their stricter prompt-everything behavior.
    ["plan", "read", "prompt"],
    ["plan", "edit_in_project", "prompt"],
    ["plan", "blocking", "prompt"],
    ["deny", "read", "prompt"],
    ["deny", "edit_in_project", "prompt"],
    ["deny", "blocking", "prompt"],
  ];

  it.each(matrix)("%s × %s → %s", (mode, tier, expected) => {
    expect(decideApprovalGate(mode, tier)).toBe(expected);
  });
});
