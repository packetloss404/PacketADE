/**
 * MultiFileEditCard — render tests with realistic JSON-STRING tool inputs.
 *
 * Regression guard for the disappearing-edits bug: the sidecars deliver
 * `AgentToolCall.input` as the raw JSON string the model produced, but the
 * card's old local parser only accepted already-parsed objects, so a turn
 * with 3+ completed write_file calls rendered ZERO edit representation
 * (ToolCallRenderer had already suppressed the individual cards). These
 * tests feed string inputs — the shape that actually crosses the wire —
 * plus the object shape some replay paths produce.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolCall } from "@/types/agent-conversation";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { MultiFileEditCard } from "@/components/agents/MultiFileEditCard";

function makeWriteCall(
  id: string,
  input: unknown,
  overrides: Partial<AgentToolCall> = {},
): AgentToolCall {
  return {
    id,
    name: "write_file",
    status: "done",
    // Runtime shape: usually the raw JSON string, occasionally an object.
    input: input as string,
    ...overrides,
  };
}

describe("MultiFileEditCard", () => {
  it("renders one row per file when inputs are JSON strings (the wire shape)", async () => {
    invokeMock.mockResolvedValue(null); // every file is new on disk
    const toolCalls = [
      makeWriteCall(
        "tc-1",
        JSON.stringify({ path: "src/app.ts", content: "export const a = 1;\n" }),
      ),
      makeWriteCall(
        "tc-2",
        JSON.stringify({ path: "src/lib/util.ts", content: "export {};\n" }),
      ),
      makeWriteCall(
        "tc-3",
        JSON.stringify({ path: "README.md", content: "# Readme\n" }),
      ),
    ];

    const { container } = render(
      <MultiFileEditCard
        toolCalls={toolCalls}
        conversationId="conv-1"
        projectPath="/tmp/project"
      />,
    );

    // The old parser bailed on string inputs and the card rendered null.
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByText(/Edited 3 files/)).toBeInTheDocument();

    // Expand and check each file row survived the string decode.
    fireEvent.click(screen.getByRole("button", { name: /Edited 3 files/ }));
    await waitFor(() => {
      expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    });
    expect(screen.getByText("src/lib/util.ts")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("accepts the file_path field alias used by some CLIs", async () => {
    invokeMock.mockResolvedValue(null);
    const toolCalls = [
      makeWriteCall(
        "tc-1",
        JSON.stringify({ file_path: "src/alias.ts", content: "export {};\n" }),
      ),
    ];

    render(
      <MultiFileEditCard
        toolCalls={toolCalls}
        conversationId="conv-1"
        projectPath="/tmp/project"
      />,
    );

    expect(await screen.findByText(/Edited 1 file\b/)).toBeInTheDocument();
  });

  it("still accepts already-parsed object inputs (replay shape)", async () => {
    invokeMock.mockResolvedValue(null);
    const toolCalls = [
      makeWriteCall("tc-1", { path: "src/obj.ts", content: "export {};\n" }),
    ];

    render(
      <MultiFileEditCard
        toolCalls={toolCalls}
        conversationId="conv-1"
        projectPath="/tmp/project"
      />,
    );

    expect(await screen.findByText(/Edited 1 file\b/)).toBeInTheDocument();
  });

  it("dedupes repeated writes to the same path (last write wins)", async () => {
    invokeMock.mockResolvedValue(null);
    const toolCalls = [
      makeWriteCall(
        "tc-1",
        JSON.stringify({ path: "src/app.ts", content: "// scaffold\n" }),
      ),
      makeWriteCall(
        "tc-2",
        JSON.stringify({ path: "src/app.ts", content: "// patched\n" }),
      ),
    ];

    render(
      <MultiFileEditCard
        toolCalls={toolCalls}
        conversationId="conv-1"
        projectPath="/tmp/project"
      />,
    );

    expect(await screen.findByText(/Edited 1 file\b/)).toBeInTheDocument();
  });

  it("renders nothing when no tool call decodes to a write", async () => {
    invokeMock.mockResolvedValue(null);
    const toolCalls = [
      makeWriteCall("tc-1", "not json at all"),
      makeWriteCall("tc-2", JSON.stringify({ nothing: "useful" })),
    ];

    const { container } = render(
      <MultiFileEditCard
        toolCalls={toolCalls}
        conversationId="conv-1"
        projectPath="/tmp/project"
      />,
    );

    expect(container.firstChild).toBeNull();
    // Flush the async diff resolution so no state update escapes the test.
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});
