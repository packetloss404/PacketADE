import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ClaudeStatusBar } from "@/components/session/ClaudeStatusBar";
import { useStatusLineStore } from "@/stores/statusLineStore";

const PROJECT = "D:\\projects\\PacketADE";

describe("ClaudeStatusBar", () => {
  beforeEach(() => {
    useStatusLineStore.setState({ byCwd: {} });
  });

  it("keeps the native status row visible while Claude produces its first snapshot", () => {
    render(<ClaudeStatusBar projectPath={PROJECT} />);

    expect(screen.getByLabelText("Claude Code status")).toHaveTextContent(
      "Collecting session status…",
    );
  });

  it("renders the collected model, context, and cost for the pane cwd", () => {
    useStatusLineStore.getState().update([
      {
        session_id: "session-1",
        model: "Opus",
        cwd: PROJECT,
        dir_name: "PacketADE",
        context_percent: 42,
        context_current_k: 84,
        context_max_k: 200,
        git_branch: "main",
        cost_usd: 1.25,
        cost_display: "$1.25",
        duration_minutes: 12,
        context_icon: "green",
        timestamp: Math.floor(Date.now() / 1000),
      },
    ]);

    render(<ClaudeStatusBar projectPath={PROJECT} />);

    expect(screen.getByText("Opus")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("$1.25")).toBeInTheDocument();
  });
});
