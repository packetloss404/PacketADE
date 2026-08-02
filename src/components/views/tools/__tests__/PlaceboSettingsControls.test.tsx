import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockImplementation(async (command: string) => {
    if (command === "mcp_server_status") return { running: false, allowWrites: false };
    if (command === "mcp_server_recent_activity") return [];
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

  it("does not offer MCP scope or tool filters that the Rust server cannot enforce", () => {
    render(<McpProviderCard />);
    expect(screen.queryByText("Scope")).not.toBeInTheDocument();
    expect(screen.queryByText(/Available Tools/)).not.toBeInTheDocument();
    // The enforceable read/write boundary remains present.
    expect(screen.getByText("Allow writes")).toBeInTheDocument();
  });
});
