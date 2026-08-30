/**
 * AgentModeChip — the single header control for autonomy after the P0-4
 * collapse (standalone Plan toggle, permission <select>, and Approve-writes
 * toggle folded into its popover). Covers the deny_all display regression
 * and the popover's mode/fine-flag wiring.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";
import type { AcpEngineCapabilities, AcpPacketcodeCapabilities } from "@/lib/tauri";
import {
  AgentModeChip,
  PROVIDER_DEFAULT_LABEL,
  RESTRICTED_MODES_HINT,
} from "@/components/agents/AgentModeChip";

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

    /**
     * Q3: how the chip presents a set the ENGINE has trimmed.
     *
     * Rules under test, all from the design spec:
     *  - hide the unsupported rows (never grey them — nothing is actionable
     *    behind the disable; the ceiling lives in another program's config),
     *  - say so ONCE, faintly, inside the popover the user already opened,
     *  - and when PacketBench's own override was dropped, label the chip with
     *    the PROVIDER's default instead of guessing a posture.
     */
    describe("restricted mode sets (ACP)", () => {
      function engine(
        over: Partial<AcpPacketcodeCapabilities> = {},
      ): AcpEngineCapabilities {
        return {
          protocolVersion: 1,
          loadSession: true,
          sessionClose: true,
          packetcode: {
            advertised: true,
            sessionsList: true,
            sessionsRename: true,
            sessionsUsage: true,
            modelsList: true,
            commandsList: null,
            projectFiles: null,
            mcpList: true,
            mcpDefaults: true,
            // What the live engine actually advertises: `plan` and `manual`
            // survive, `default`/`yolo` do not, and `deny` collides with
            // `plan` on `read-only`.
            permissionModes: ["ask", "read-only"],
            defaultPermissionMode: null,
            ...over,
          },
        };
      }

      it("offers only the postures the engine will honor", () => {
        renderChip({ permissionMode: "ask_for_risky", engineCapabilities: engine() });
        fireEvent.click(screen.getByLabelText("Permission options"));
        expect(
          screen.getAllByRole("menuitemradio").map((r) => r.textContent),
        ).toEqual([
          expect.stringContaining("Plan"),
          expect.stringContaining("Manual"),
        ]);
        // Hidden, not disabled: there is no greyed escape hatch to hunt for.
        expect(screen.queryByText("Yolo")).toBeNull();
        expect(screen.queryByRole("menuitemradio", { name: /Yolo/ })).toBeNull();
      });

      it("explains the restriction once, inside the popover", () => {
        renderChip({ permissionMode: "ask_for_risky", engineCapabilities: engine() });
        // Not announced before the user asks.
        expect(screen.queryByText(RESTRICTED_MODES_HINT)).toBeNull();
        fireEvent.click(screen.getByLabelText("Permission options"));
        expect(screen.getByText(RESTRICTED_MODES_HINT)).toBeTruthy();
      });

      it("still names the restriction when only the deny/plan collision trims it", () => {
        // The whole ACP ladder is advertised, yet `deny` and `plan` both map
        // to `read-only`, so PacketBench can honestly offer four of its five
        // postures. Four is still fewer than five — the hint is truthful and
        // must not be suppressed just because the engine refused nothing.
        renderChip({
          permissionMode: "ask_for_risky",
          engineCapabilities: engine({
            permissionModes: ["ask", "accept-edits", "auto", "read-only", "bypass"],
          }),
        });
        fireEvent.click(screen.getByLabelText("Permission options"));
        expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
        expect(screen.queryByRole("menuitemradio", { name: /Deny/ })).toBeNull();
        expect(screen.getByText(RESTRICTED_MODES_HINT)).toBeTruthy();
      });

      it("labels an offered posture normally even on a restricted session", () => {
        renderChip({ permissionMode: "ask_for_risky", engineCapabilities: engine() });
        expect(screen.getByText("Manual")).toBeTruthy();
        expect(screen.queryByText(PROVIDER_DEFAULT_LABEL)).toBeNull();
      });

      it("renders the provider's own default when the derived posture is not offered", () => {
        // permissionMode "auto" derives to `default`, whose ACP mode the
        // engine refuses — so the override was dropped and the session is
        // really running the engine's `read-only`.
        renderChip({
          permissionMode: "auto",
          engineCapabilities: engine({ defaultPermissionMode: "read-only" }),
        });
        expect(screen.getByText("Read only")).toBeTruthy();
        // Never "Default": that is a PacketBench posture meaning full tools.
        expect(screen.queryByText("Default")).toBeNull();
      });

      it('falls back to "Provider default" rather than guessing a posture', () => {
        renderChip({ permissionMode: "auto", engineCapabilities: engine() });
        expect(screen.getByText(PROVIDER_DEFAULT_LABEL)).toBeTruthy();
        expect(screen.queryByText("Default")).toBeNull();
      });

      it("keeps the popover usable in the provider-default state", () => {
        renderChip({ permissionMode: "auto", engineCapabilities: engine() });
        fireEvent.click(screen.getByLabelText("Permission options"));
        expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
        // Nothing claims to be the current posture — PacketBench set none.
        expect(
          screen
            .getAllByRole("menuitemradio")
            .filter((r) => r.getAttribute("aria-checked") === "true"),
        ).toHaveLength(0);
      });

      it("never restricts on an engine that advertised no ceiling", () => {
        // Unknown is NOT restricted — the chip must not flip to two postures
        // because a capability fetch has not landed.
        renderChip({ permissionMode: "auto", engineCapabilities: undefined });
        expect(screen.getByText("Default")).toBeTruthy();
        fireEvent.click(screen.getByLabelText("Permission options"));
        expect(screen.getAllByRole("menuitemradio")).toHaveLength(5);
        expect(screen.queryByText(RESTRICTED_MODES_HINT)).toBeNull();
      });
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
