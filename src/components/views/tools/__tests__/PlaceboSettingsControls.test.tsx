import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockImplementation(async (command: string) => {
    if (command === "mcp_server_status")
      return { running: false, allowWrites: false, servedTools: [] };
    if (command === "mcp_server_recent_activity") return [];
    if (command === "mcp_server_available_tools")
      return [
        { name: "ping", description: "Health check" },
        { name: "get_active_flight", description: "Active flight" },
      ];
    if (command === "get_aux_provider_options")
      return [
        { provider: "anthropic", defaultModel: "haiku", needsApiKey: true, configured: false },
      ];
    if (command === "get_aux_route_resolutions") return [];
    return undefined;
  }),
}));

import { AgentSettingsCard } from "@/components/views/tools/AgentSettingsCard";
import { McpProviderCard } from "@/components/views/tools/McpProviderCard";
import { WorkspaceSettingsCard } from "@/components/views/tools/WorkspaceSettingsCard";
import { ProviderRoutingCard } from "@/components/views/tools/ProviderRoutingCard";
import { useMcpProviderStore } from "@/stores/mcpProviderStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { AUX_TASK_CLASS_CAVEATS, ALL_AUX_TASK_CLASSES } from "@/types/routing";

describe("Settings runtime honesty", () => {
  beforeEach(() => {
    useMcpProviderStore.setState({
      serverStatus: null,
      serverError: null,
      serverBusy: false,
      activity: [],
    });
  });

  it("does not offer the retired Agent right-rail default", () => {
    render(<AgentSettingsCard />);
    expect(screen.queryByText("Start right rail collapsed")).not.toBeInTheDocument();
  });

  it("does not offer an MCP scope the Rust server cannot enforce", () => {
    // `scope` was REMOVED rather than enforced: the provider server reads the
    // single global state file and its resources are inherently global, so
    // there was no "project" reading of it to implement.
    render(<McpProviderCard />);
    expect(screen.queryByText("Scope")).not.toBeInTheDocument();
    // The enforceable read/write boundary remains present.
    expect(screen.getByText("Allow writes")).toBeInTheDocument();
  });

  it("offers the per-tool filter now that the Rust router enforces it", async () => {
    // This control was previously removed BECAUSE it was dead config. It is
    // back because `mcp_server_start` now receives the allowlist and the
    // router disables every tool outside it, at `tools/list` AND `tools/call`.
    render(<McpProviderCard />);
    expect(await screen.findByText(/Available Tools/)).toBeInTheDocument();
    // Rendered from the BACKEND catalogue, not a hardcoded copy — `ping` was
    // never in the old hardcoded list, so seeing it proves the source.
    expect(await screen.findByText("ping")).toBeInTheDocument();
  });

  /**
   * FAULT: the app-wide "default new workspaces to bypass permission prompts"
   * toggle carried no caveat, while the creation modal and the workspace
   * header both said the flag never reaches OpenCode or PacketCode. A default
   * that over-promises is the same lie one step earlier.
   */
  it("does not let the bypass DEFAULT promise more than a launch delivers", () => {
    useWorkspaceStore.setState({ defaultBypassPermissions: true });
    render(<WorkspaceSettingsCard />);
    expect(screen.getByText(/Not applied to OpenCode and PacketCode/)).toBeInTheDocument();
  });

  it("keeps the bypass caveat out of the way while the default is off", () => {
    useWorkspaceStore.setState({ defaultBypassPermissions: false });
    render(<WorkspaceSettingsCard />);
    expect(screen.queryByText(/Not applied to OpenCode and PacketCode/)).not.toBeInTheDocument();
  });

  /**
   * FAULT: three rows of the auxiliary-routing table configured nothing.
   * `issue-investigate` and `agent-chat` still shell out to the local Claude
   * CLI and never consult the route at all — which also made the section's
   * blanket "these never use a subscription login" false.
   * `commands/aux_routing.rs::unrouted_aux_surfaces_stay_declared` fails if
   * either is migrated without this list being trimmed.
   *
   * `memory-scan` was the third, and is no longer flagged: the Memory pane's
   * "Scan codebase" button invokes `scan_codebase_memory`, so the row now
   * configures a feature the user can actually run. A caveat left in place
   * here would be the same lie in the opposite direction.
   */
  it("flags every auxiliary routing row that cannot take effect yet", () => {
    expect(Object.keys(AUX_TASK_CLASS_CAVEATS).sort()).toEqual([
      "agent-chat",
      "issue-investigate",
    ]);
    // Every flagged class must still be a real row, or the note renders nowhere.
    for (const taskClass of Object.keys(AUX_TASK_CLASS_CAVEATS)) {
      expect(ALL_AUX_TASK_CLASSES).toContain(taskClass);
    }
    // The two CLI-backed ones must say why, since the section header's
    // no-subscription claim does not hold for them.
    expect(AUX_TASK_CLASS_CAVEATS["agent-chat"]).toMatch(/Claude CLI/);
    expect(AUX_TASK_CLASS_CAVEATS["issue-investigate"]).toMatch(/Claude CLI/);
    // The reachable row carries no caveat at all.
    expect(AUX_TASK_CLASS_CAVEATS["memory-scan"]).toBeUndefined();
  });

  it("renders the unrouted flags next to the rows they belong to", async () => {
    render(<ProviderRoutingCard />);
    // The pickers still work — the row is honest, not disabled.
    expect(await screen.findByLabelText("Agent chat provider")).toBeInTheDocument();
    expect(screen.getAllByText(/still runs the local Claude CLI/)).toHaveLength(2);
    expect(screen.queryByText(/no PacketBench surface invokes a codebase scan/)).toBeNull();
    // …and the section header no longer makes the blanket claim the two
    // CLI-backed rows falsify.
    expect(
      screen.getByText(/No task routed through this table uses a Claude or ChatGPT subscription/),
    ).toBeInTheDocument();
  });

  /**
   * `transcriptViewMode` and `worktreeCleanupPolicy` were persisted global
   * state whose only affordance was a chat-header overflow menu (and, for the
   * cleanup policy, nothing at all). Both now have a control here.
   */
  it("offers a control for every persisted agent preference a user can change", () => {
    useAgentSettingsStore.setState({
      transcriptViewMode: "normal",
      worktreeCleanupPolicy: "only-when-safe",
    });
    render(<AgentSettingsCard />);

    fireEvent.click(screen.getByRole("button", { name: "Verbose" }));
    expect(useAgentSettingsStore.getState().transcriptViewMode).toBe("verbose");

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(useAgentSettingsStore.getState().worktreeCleanupPolicy).toBe("never");

    // Both survive a reload — the store is the persistence boundary.
    useAgentSettingsStore.getState().hydrateFromStorage();
    expect(useAgentSettingsStore.getState().transcriptViewMode).toBe("verbose");
    expect(useAgentSettingsStore.getState().worktreeCleanupPolicy).toBe("never");
  });
});
