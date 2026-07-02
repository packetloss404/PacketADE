import { describe, expect, it } from "vitest";
import { parseToolInput, parseWriteFileInput } from "@/lib/parseToolInput";
import type { AgentToolCall } from "@/types/agent-conversation";

function makeCall(input: unknown): AgentToolCall {
  return {
    id: "tc-1",
    name: "write_file",
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
