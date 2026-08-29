import { render, screen } from "@testing-library/react";
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
    return undefined;
  }),
}));

import { AgentSettingsCard } from "@/components/views/tools/AgentSettingsCard";
import { McpProviderCard } from "@/components/views/tools/McpProviderCard";
import { useMcpProviderStore } from "@/stores/mcpProviderStore";

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
});
