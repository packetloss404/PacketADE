import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyndicateMachinesCard } from "@/components/views/tools/SyndicateMachinesCard";
import { useSyndicateStore } from "@/stores/syndicateStore";
import { useServerStore } from "@/stores/serverStore";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("SyndicateMachinesCard integration toggle", () => {
  beforeEach(() => {
    invoke.mockClear();
    useSyndicateStore.setState({
      enabled: true,
      machines: [],
      connectionErrors: {},
      workspaceCache: {},
      catalogCache: {},
    });
    useServerStore.setState({ servers: [] });
  });

  it("disables the integration without deleting paired configuration", async () => {
    useSyndicateStore.setState({
      machines: [
        {
          machineId: "machine-1",
          displayName: "Build host",
          deviceId: "device-1",
          serverConfigId: "server-1",
          localPort: 4317,
          machineSigningFingerprint: "fingerprint",
          grantStatus: "active",
          scopes: ["machine.read"],
          addedAt: 1,
        },
      ],
    });
    render(<SyndicateMachinesCard />);

    const toggle = screen.getByRole("switch", { name: "Syndicate integration" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(invoke).toHaveBeenCalledWith("syndicate_disable_integration");
    expect(
      screen.getByText(/1 paired machine and all saved remote Workspace data are retained/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pair machine/i })).not.toBeInTheDocument();
    expect(useSyndicateStore.getState().machines).toHaveLength(1);
  });
});
