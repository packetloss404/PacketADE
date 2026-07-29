import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpHubCard } from "../McpHubCard";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMcpStore } from "@/stores/mcpStore";
import { useMcpTrustStore } from "@/stores/mcpTrustStore";
import { useProvenanceAuditStore } from "@/stores/provenanceAuditStore";

vi.mock("../McpServersCard", () => ({
  McpServersCard: () => <div>Configured servers editor</div>,
}));
vi.mock("../McpProviderCard", () => ({
  McpProviderCard: () => <div>PacketADE provider controls</div>,
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (
    selector: (state: {
      selectedConversationId: null;
      conversations: [];
      prepareMcpReconnect: ReturnType<typeof vi.fn>;
    }) => unknown,
  ) =>
    selector({
      selectedConversationId: null,
      conversations: [],
      prepareMcpReconnect: vi.fn(),
    }),
}));
vi.mock("@/lib/tauri", () => ({
  diagnoseMcpServer: vi.fn(),
  readMcpServers: vi.fn(),
  writeMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
}));

describe("McpHubCard", () => {
  beforeEach(() => {
    localStorage.clear();
    useLayoutStore.setState({ projectPath: "D:\\projects\\demo" });
    useMcpTrustStore.setState({ profiles: {}, capabilities: {} });
    useProvenanceAuditStore.setState({ entries: [] });
    useMcpStore.setState({
      servers: [
        {
          name: "demo",
          scope: "project",
          disabled: false,
          config: { command: "node", args: ["server.js"] },
          rawConfig: { command: "node", args: ["server.js"] },
        },
      ],
      loading: false,
      error: null,
      fetchServers: vi.fn().mockResolvedValue(undefined),
      addServer: vi.fn().mockResolvedValue(undefined),
      updateServer: vi.fn().mockResolvedValue(undefined),
      removeServer: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("searches the catalog and requires a review before writing config", async () => {
    render(<McpHubCard />);

    expect(screen.getByText("Filesystem")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search MCP Hub"), {
      target: { value: "github" },
    });
    expect(screen.queryByText("Filesystem")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    expect(screen.getByText("Review GitHub")).toBeInTheDocument();
    expect(
      screen.getByText(/GITHUB_PERSONAL_ACCESS_TOKEN.*never stored/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve and add" }));

    await waitFor(() =>
      expect(useMcpStore.getState().addServer).toHaveBeenCalledTimes(1),
    );
  });

  it("discloses frozen trust and non-overridable denial floors", () => {
    render(<McpHubCard />);
    expect(
      screen.getByText(/Trust edits never broaden a running session/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Credential, outside-workspace, and protected publish/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Write" })).not.toBeChecked();
  });
});
