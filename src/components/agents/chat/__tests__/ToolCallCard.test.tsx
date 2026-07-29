/**
 * ToolCallCard — generic (non-edit, non-bash, non-subagent, non-task-list)
 * bucket. P1-17: uniform one-line verb rows (icon · verb · target · status)
 * driven by the global transcriptViewMode store instead of a per-call prop.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentToolCall } from "@/types/agent-conversation";

import { ToolCallCard } from "@/components/agents/chat/ToolCallCard";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { toolResultProvenance } from "@/lib/provenance";

function webFetchCall(overrides: Partial<AgentToolCall> = {}): AgentToolCall {
  return {
    id: "tc-1",
    name: "web_fetch",
    status: "done",
    input: JSON.stringify({ url: "https://example.com/docs" }),
    summary: "Fetched 12KB",
    fullContent: "<html>…full page body…</html>",
    ...overrides,
  };
}

describe("ToolCallCard — generic verb row", () => {
  beforeEach(() => {
    useAgentSettingsStore.setState({ transcriptViewMode: "normal" });
  });

  it("renders icon · verb · target · status on one line", () => {
    render(
      <ToolCallCard
        toolCall={webFetchCall()}
        conversationId="conv-1"
        projectPath="/repo"
      />,
    );
    expect(screen.getByText("Fetched")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/docs")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("expands the body on click in normal mode", () => {
    render(
      <ToolCallCard
        toolCall={webFetchCall()}
        conversationId="conv-1"
        projectPath="/repo"
      />,
    );
    expect(
      screen.queryByText("<html>…full page body…</html>"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /expand/i }));

    expect(
      screen.getByText("<html>…full page body…</html>"),
    ).toBeInTheDocument();
  });

  it("is not expandable in summary mode", () => {
    useAgentSettingsStore.setState({ transcriptViewMode: "summary" });
    render(
      <ToolCallCard
        toolCall={webFetchCall()}
        conversationId="conv-1"
        projectPath="/repo"
      />,
    );
    expect(
      screen.queryByRole("button", { name: /expand/i }),
    ).not.toBeInTheDocument();
  });

  it("shows raw input only in verbose mode, once expanded", () => {
    useAgentSettingsStore.setState({ transcriptViewMode: "verbose" });
    render(
      <ToolCallCard
        toolCall={webFetchCall()}
        conversationId="conv-1"
        projectPath="/repo"
      />,
    );
    // Verbose mounts already expanded.
    expect(
      screen.getByText((_, node) =>
        node?.textContent === 'input: {"url":"https://example.com/docs"}',
      ),
    ).toBeInTheDocument();
  });

  it("shows an inspectable source chip for external evidence", () => {
    render(
      <ToolCallCard
        toolCall={webFetchCall({
          provenance: toolResultProvenance({
            toolId: "tc-1",
            name: "web_fetch",
            input: JSON.stringify({ url: "https://example.com/docs?token=x" }),
            content: "page",
          }),
        })}
        conversationId="conv-1"
        projectPath="/repo"
      />,
    );

    const chip = screen.getByRole("button", { name: "Source: Web evidence" });
    fireEvent.click(chip);
    const detail = screen.getByRole("status");
    expect(within(detail).getByText("https://example.com/docs")).toBeInTheDocument();
    expect(within(detail).getByText(/Authority: evidence only/)).toBeInTheDocument();
  });
});
