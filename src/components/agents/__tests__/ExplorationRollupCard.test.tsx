/**
 * ExplorationRollupCard — live-verb vs settled-verb behavior.
 *
 * Regression guard for the orphaned-running-call bug: nothing in the app
 * ever settles a tool call's "running" status when a turn is cancelled or
 * errors (cancelActiveConversation / failTurn / the done+error listeners
 * only flip `isStreaming`, and hydration persists tool statuses as-is), so
 * a settled message can carry running exploration calls forever. The card
 * must key its live state off the message's `isStreaming`, not the raw
 * running count, or those messages permanently show "Exploring (N in
 * flight)".
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentToolCall } from "@/types/agent-conversation";

import { ExplorationRollupCard } from "@/components/agents/ExplorationRollupCard";

function makeCall(
  id: string,
  name: string,
  status: AgentToolCall["status"],
  input?: unknown,
): AgentToolCall {
  return {
    id,
    name,
    status,
    input: input === undefined ? undefined : JSON.stringify(input),
  };
}

describe("ExplorationRollupCard", () => {
  it("shows the live verb and in-flight count while the message streams", () => {
    render(
      <ExplorationRollupCard
        isStreaming
        toolCalls={[
          makeCall("tc-1", "read_file", "done", { path: "src/app.ts" }),
          makeCall("tc-2", "grep", "running"),
        ]}
      />,
    );
    expect(screen.getByText("Exploring 1 file (1 in flight)")).toBeTruthy();
  });

  it("ignores orphaned running calls once the message has settled", () => {
    render(
      <ExplorationRollupCard
        isStreaming={false}
        toolCalls={[
          makeCall("tc-1", "read_file", "done", { path: "src/app.ts" }),
          // Cancelled mid-flight: no result ever landed, status stuck "running".
          makeCall("tc-2", "grep", "running"),
        ]}
      />,
    );
    expect(screen.getByText("Explored 1 file")).toBeTruthy();
    expect(screen.queryByText(/in flight/)).toBeNull();
  });

  it("renders nothing for a settled message whose only exploration calls are orphaned", () => {
    const { container } = render(
      <ExplorationRollupCard
        isStreaming={false}
        toolCalls={[makeCall("tc-1", "read_file", "running")]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
