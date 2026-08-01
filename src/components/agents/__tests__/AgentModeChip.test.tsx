/**
 * AgentModeChip — the single header control for autonomy after the P0-4
 * collapse (standalone Plan toggle, permission <select>, and Approve-writes
 * toggle folded into its popover). Covers the deny_all display regression
 * and the popover's mode/fine-flag wiring.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";
import { AgentModeChip } from "@/components/agents/AgentModeChip";

function conversation(overrides: Partial<AgentConversation>): AgentConversation {
  return {
    id: "conv-1",
    title: "Conversation",
    // Default to an approval-CAPABLE provider so the full five-mode set is
    // asserted here; Codex-specific filtering is covered separately below.
    agent: "api-claude",
    projectPath: "/repo",
    status: "idle",
    messages: [],
    sessionId: "session-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    ...overrides,
  };
}

function renderChip(overrides: Partial<AgentConversation> = {}) {
  const onCycle = vi.fn();
  const onSelectMode = vi.fn();
  const onSetApproveWrites = vi.fn();
  render(
    <AgentModeChip
      conversation={conversation(overrides)}
      onCycle={onCycle}
      onSelectMode={onSelectMode}
      onSetApproveWrites={onSetApproveWrites}
    />,
  );
  return { onCycle, onSelectMode, onSetApproveWrites };
}

describe("AgentModeChip", () => {
  // Regression: deny_all sessions used to display as full-tools "Default".
  it("labels a deny_all session Deny, not Default", () => {
    renderChip({ permissionMode: "deny_all" });
    expect(screen.getByText("Deny")).toBeTruthy();
    expect(screen.queryByText("Default")).toBeNull();
  });

  it("cycles mode when the main pill is clicked", () => {
    const { onCycle } = renderChip({ permissionMode: "auto" });
    fireEvent.click(screen.getByText("Default"));
    expect(onCycle).toHaveBeenCalledTimes(1);
  });

  it("opens a popover listing every mode plus the Approve-writes fine flag", () => {
    renderChip({ permissionMode: "auto" });
    fireEvent.click(screen.getByLabelText("Permission options"));
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Default"),
      expect.stringContaining("Plan"),
      expect.stringContaining("Manual"),
      expect.stringContaining("Deny"),
      expect.stringContaining("Yolo"),
    ]);
    expect(
      screen.getByRole("menuitemcheckbox", { name: /Approve writes/ }),
    ).toBeTruthy();
  });

  it("marks the current mode selected in the popover", () => {
    renderChip({ permissionMode: "deny_all" });
    fireEvent.click(screen.getByLabelText("Permission options"));
    const selected = screen
      .getAllByRole("menuitemradio")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("Deny");
  });

  it("selects a mode from the popover and closes it", () => {
    const { onSelectMode } = renderChip({ permissionMode: "auto" });
    fireEvent.click(screen.getByLabelText("Permission options"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Yolo/ }));
    expect(onSelectMode).toHaveBeenCalledWith("yolo");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("toggles Approve writes from the popover without changing mode", () => {
    const { onSelectMode, onSetApproveWrites } = renderChip({
      permissionMode: "ask_for_risky",
      approveWrites: false,
    });
    fireEvent.click(screen.getByLabelText("Permission options"));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /Approve writes/ }),
    );
    expect(onSetApproveWrites).toHaveBeenCalledWith(true);
    expect(onSelectMode).not.toHaveBeenCalled();
  });

  it("reflects an enabled Approve-writes flag in the popover toggle", () => {
    renderChip({ permissionMode: "auto", approveWrites: true });
    fireEvent.click(screen.getByLabelText("Permission options"));
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: /Approve writes/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  // P1-S4 capability filtering. The only row that ever set
  // `supportsApprovals: false` was `api-openai-codex` (Codex `exec`, whose
  // stdin was closed), and that row was removed in 2026-07. The filtering
  // MACHINERY is still live and still unit-tested against both booleans in
  // `agentModeChipUtils.test.ts`; what these assert is that no live provider
  // — and no retired one — silently loses modes through the catalog.
  describe("capability filtering", () => {
    it("offers the full five-mode set for every live provider", () => {
      for (const agent of [
        "api-claude-oauth",
        "api-claude",
        "api-openai",
        "api-openai-agents",
        "api-minimax",
        "api-openrouter",
        "api-ollama",
      ]) {
        const { unmount } = render(
          <AgentModeChip
            conversation={conversation({ agent, permissionMode: "auto" })}
            onCycle={vi.fn()}
            onSelectMode={vi.fn()}
            onSetApproveWrites={vi.fn()}
          />,
        );
        fireEvent.click(screen.getByLabelText("Permission options"));
        const radios = screen.getAllByRole("menuitemradio");
        expect(radios.map((r) => r.textContent)).toEqual([
          expect.stringContaining("Default"),
          expect.stringContaining("Plan"),
          expect.stringContaining("Manual"),
          expect.stringContaining("Deny"),
          expect.stringContaining("Yolo"),
        ]);
        unmount();
      }
    });

    it("does not sandbox-relabel a retired provider id", () => {
      // `api-openai-codex` has no catalog row now, so
      // `providerSupportsApprovals` defaults it to true. A read-only stored
      // conversation on that id must render the ordinary vocabulary rather
      // than a half-applied Codex sandbox skin.
      renderChip({ agent: "api-openai-codex", permissionMode: "auto" });
      expect(screen.getByText("Default")).toBeTruthy();
      expect(screen.queryByText("Workspace-write")).toBeNull();
    });
  });
});
