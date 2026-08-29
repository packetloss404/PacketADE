/**
 * The two agent settings that were persisted but had no control.
 *
 * `transcriptViewMode` was reachable only from a conversation's header
 * overflow menu, so a user with no conversation open could not change it at
 * all; `worktreeCleanupPolicy` — which decides whether archiving a
 * conversation removes its worktree — had no UI anywhere, while
 * `sessionGlue.ts` read it on every archive. A setting the user cannot see is
 * a setting they cannot consent to.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_WORKTREE_CLEANUP_POLICY,
  useAgentSettingsStore,
} from "@/stores/agentSettingsStore";
import { AgentSettingsCard } from "@/components/views/tools/AgentSettingsCard";

describe("AgentSettingsCard — transcript density", () => {
  beforeEach(() => {
    useAgentSettingsStore.setState({ transcriptViewMode: "normal" });
  });

  it("shows the persisted value and writes the chosen one", () => {
    render(<AgentSettingsCard />);

    const group = screen.getByRole("group", { name: "Transcript density" });
    expect(screen.getByRole("button", { name: "Normal" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Verbose" }));

    expect(useAgentSettingsStore.getState().transcriptViewMode).toBe("verbose");
    expect(group).toBeInTheDocument();
  });
});

describe("AgentSettingsCard — worktree cleanup on archive", () => {
  beforeEach(() => {
    useAgentSettingsStore.setState({
      worktreeCleanupPolicy: DEFAULT_WORKTREE_CLEANUP_POLICY,
    });
  });

  it("offers all three ruled policies and persists the choice", () => {
    render(<AgentSettingsCard />);

    const group = screen.getByRole("group", { name: "Worktree cleanup on archive" });
    for (const label of ["Keep", "When safe", "Always"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "When safe" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(useAgentSettingsStore.getState().worktreeCleanupPolicy).toBe("never");

    fireEvent.click(screen.getByRole("button", { name: "Always" }));
    expect(useAgentSettingsStore.getState().worktreeCleanupPolicy).toBe("always");
    expect(group).toBeInTheDocument();
  });

  // "Always" removes a CLEAN worktree only — no non-Discard path ever removes
  // uncommitted work. The control must not read as if it could.
  it("states that uncommitted work is never removed by any policy", () => {
    render(<AgentSettingsCard />);
    expect(screen.getByText(/uncommitted work is never removed/i)).toBeInTheDocument();
  });
});
