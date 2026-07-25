import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedState } from "@/lib/tauri";

const mocks = vi.hoisted(() => ({
  detectCliCatalog: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  detectCliCatalog: mocks.detectCliCatalog,
  loadPersistedState: mocks.loadPersistedState,
  saveAgentsSlice: mocks.saveAgentsSlice,
}));

describe("agentStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.saveAgentsSlice.mockResolvedValue(undefined);
  });

  it("hydrates persisted built-in command and default args overrides", async () => {
    const { useAgentStore } = await import("@/stores/agentStore");

    await useAgentStore.getState().hydrateFromBackend({
      agents: [
        {
          id: "codex",
          command: "C:\\tools\\codex-wrapper.cmd",
          defaultArgs: ["--ask-for-approval", "never"],
          installed: true,
          isBuiltin: true,
        },
      ],
    } as unknown as PersistedState);

    const codex = useAgentStore.getState().getAgent("codex");

    expect(codex).toMatchObject({
      command: "C:\\tools\\codex-wrapper.cmd",
      defaultArgs: ["--ask-for-approval", "never"],
      installed: true,
      isBuiltin: true,
    });
  });

  it("keeps custom agents while resetBuiltins restores built-in defaults", async () => {
    const { useAgentStore } = await import("@/stores/agentStore");

    useAgentStore.getState().addAgent({
      id: "custom-echo",
      name: "Echo Agent",
      command: "echo-agent",
      defaultArgs: ["--verbose"],
      description: "Custom test CLI",
      installed: false,
      capabilities: [],
      icon: "TerminalSquare",
      color: "text-text-muted",
      statusPatterns: {
        approval: [],
        thinking: [],
        toolUse: [],
        idle: [],
      },
      isBuiltin: false,
    });
    useAgentStore.getState().updateAgent("codex", {
      command: "C:\\tools\\codex-wrapper.cmd",
      defaultArgs: ["--debug"],
    });

    useAgentStore.getState().resetBuiltins();

    expect(useAgentStore.getState().getAgent("codex")).toMatchObject({
      command: "codex",
      defaultArgs: [],
      isBuiltin: true,
    });
    expect(useAgentStore.getState().getAgent("custom-echo")).toMatchObject({
      command: "echo-agent",
      defaultArgs: ["--verbose"],
      isBuiltin: false,
    });
  });
});
