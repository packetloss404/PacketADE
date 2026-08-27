import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/agents/composer/Composer";
import { LAUNCH_DRAFT_KEY, useAgentDraftStore } from "@/stores/agentDraftStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { AcpEngineCapabilities } from "@/lib/tauri";
import { clearEngineCommandCache } from "@/components/agents/hooks/useEngineSlashCommands";

const mocks = vi.hoisted(() => ({
  agentTaskState: {
    selectedRepo: "D:\\projects\\PacketBench" as string | null,
    selectedConversationId: null as string | null,
    conversations: [] as unknown[],
    cancellingConversationIds: new Set<string>(),
    setSelectedRepo: vi.fn(),
    sendMessage: vi.fn(),
    cancelActiveConversation: vi.fn(),
    createApiConversation: vi.fn(),
    selectConversation: vi.fn(),
    setPlanMode: vi.fn(),
  },
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
  acpListCommands: vi.fn(),
  acpSearchFiles: vi.fn(),
  acpSessionUsage: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/stores/agentTaskStore", () => {
  const useAgentTaskStore = Object.assign(
    vi.fn((selector: (state: typeof mocks.agentTaskState) => unknown) =>
      selector(mocks.agentTaskState),
    ),
    {
      getState: vi.fn(() => mocks.agentTaskState),
    },
  );
  // The real map, not a prefix-strip: `api-claude` is `anthropic`, and a
  // mock that models the bug teaches the next reader the wrong shape.
  // `api-openai-codex` is RETIRED but keeps its identity entry so a stored
  // record cannot fall through to the anthropic default.
  const apiAgentProvider = (agent: string) =>
    (
      ({
        "api-claude-oauth": "claude-oauth",
        "api-claude": "anthropic",
        "api-openai-codex": "openai-codex",
        "api-openai-agents": "openai-agents",
        "api-openai": "openai",
        "api-minimax": "minimax",
        "api-openrouter": "openrouter",
        "api-ollama": "ollama",
      }) as Record<string, string>
    )[agent] ?? "anthropic";
  return {
    useAgentTaskStore,
    apiAgentProvider,
    // Auth BADGES key on the credential, not the routing target: the Agent
    // SDK row routes as `claude-oauth` but authenticates with the Anthropic
    // API key, so its badge probes `anthropic`.
    authProbeProvider: (agent: string) => {
      const routing = apiAgentProvider(agent);
      return routing === "claude-oauth" ? "anthropic" : routing;
    },
    repoDisplayName: (path: string) => path.split(/[\\/]/).pop() ?? path,
  };
});

vi.mock("@/stores/githubStore", () => ({
  useGitHubStore: vi.fn((selector: (state: { repos: unknown[] }) => unknown) =>
    selector({ repos: [] }),
  ),
}));

vi.mock("@/stores/projectHistoryStore", () => ({
  useProjectHistoryStore: vi.fn(
    (selector: (state: { projects: unknown[]; recordOpen: () => void }) => unknown) =>
      selector({ projects: [], recordOpen: vi.fn() }),
  ),
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: vi.fn(
    (selector: (state: { servers: unknown[]; updateServer: () => void }) => unknown) =>
      selector({ servers: [], updateServer: vi.fn() }),
  ),
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: vi.fn((selector: (state: { setActiveView: () => void }) => unknown) =>
    selector({ setActiveView: vi.fn() }),
  ),
}));

vi.mock("@/stores/promptStore", () => ({
  usePromptStore: vi.fn((selector: (state: { templates: unknown[] }) => unknown) =>
    selector({ templates: [] }),
  ),
}));

vi.mock("@/stores/profileStore", () => ({
  useProfileStore: vi.fn(
    (
      selector: (state: {
        profiles: Array<{ id: string; name: string; description: string; isBuiltin: boolean }>;
        defaultProfileId: string;
        setDefaultProfile: () => void;
      }) => unknown,
    ) =>
      selector({
        profiles: [
          {
            id: "default",
            name: "Default",
            description: "Default profile",
            isBuiltin: true,
          },
        ],
        defaultProfileId: "default",
        setDefaultProfile: vi.fn(),
      }),
  ),
}));

vi.mock("@/hooks/useVoiceInput", () => ({
  useVoiceInput: () => ({
    isListening: false,
    transcript: "",
    startListening: vi.fn(),
    stopListening: vi.fn(),
    isSupported: false,
  }),
}));

vi.mock("@/components/agents/FileMentionPopover", () => ({
  FileMentionPopover: () => null,
}));

vi.mock("@/lib/tauri", () => ({
  getProviderAuthStatus: vi.fn(() => Promise.resolve({ status: "ready", hint: "" })),
  listOllamaModels: vi.fn(() => Promise.resolve([])),
  listSlashCommands: vi.fn(() => Promise.resolve([])),
  listSkills: vi.fn(() => Promise.resolve([])),
  // The composer's context strip owns the git poll now (it moved off the
  // deleted SessionMetaLine band), so this export has to resolve here.
  gitSafetyCheck: vi.fn(() => Promise.resolve(null)),
  // ACP engine queries. Only reachable for a conversation carrying an
  // `engineCapabilities` record — every other test here leaves them untouched,
  // which is itself the assertion that a non-engine session pays no round trip.
  acpListCommands: (...args: unknown[]) => mocks.acpListCommands(...args),
  acpSearchFiles: (...args: unknown[]) => mocks.acpSearchFiles(...args),
  acpSessionUsage: (...args: unknown[]) => mocks.acpSessionUsage(...args),
}));

function renderLaunch(onLaunch: (text: string, attachments: unknown[]) => boolean) {
  return render(
    <Composer
      variant="launch"
      textareaRef={createRef<HTMLTextAreaElement>()}
      selectedAgent="api-minimax"
      onAgentChange={vi.fn()}
      onLaunch={onLaunch}
      selectedModel="MiniMax-M2.5"
      onModelChange={vi.fn()}
    />,
  );
}

function makeConversation(id: string): AgentConversation {
  return {
    id,
    title: "Chat test",
    agent: "api-openai",
    projectPath: "D:\\projects\\PacketBench",
    status: "idle",
    messages: [],
    sessionId: id,
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    provider: "openai",
    model: "gpt-4o",
  };
}

function renderChat(conversation: AgentConversation) {
  return render(
    <Composer
      variant="chat"
      conversationId={conversation.id}
      conversation={conversation}
      pendingApprovalCount={0}
      onCancelPending={vi.fn()}
      onCycleMode={vi.fn()}
      onSelectMode={vi.fn()}
      onSetApproveWrites={vi.fn()}
      onChangeModel={vi.fn()}
    />,
  );
}

async function stageImage(name = "shot.png") {
  const file = new File(["image-bytes"], name, { type: "image/png" });
  const textarea = screen.getByPlaceholderText(/what would you like to work on/i);
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [
        {
          kind: "file",
          getAsFile: () => file,
        },
      ],
    },
  });
  await screen.findByText(name);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAgentDraftStore.setState({ drafts: {} });
  mocks.agentTaskState.selectedRepo = "D:\\projects\\PacketBench";
  mocks.agentTaskState.cancellingConversationIds = new Set<string>();
  // jsdom has no layout engine, and `InputPopover` scrolls its highlighted row
  // into view the moment the `/` or `@` menu has rows. Without this shim the
  // effect throws and takes the whole render down.
  Element.prototype.scrollIntoView = vi.fn();
  clearEngineCommandCache();
  mocks.acpListCommands.mockResolvedValue([]);
  mocks.acpSearchFiles.mockResolvedValue([]);
  mocks.acpSessionUsage.mockResolvedValue(null);
  let counter = 0;
  mocks.createObjectURL.mockImplementation(() => `blob:preview-${++counter}`);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: mocks.createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: mocks.revokeObjectURL,
  });
});

describe("Composer (launch variant) — image attachments", () => {
  it("keeps staged images when launch is rejected as a no-op", async () => {
    useAgentDraftStore.getState().setDraft(LAUNCH_DRAFT_KEY, "describe this screenshot");
    const onLaunch = vi.fn((_text: string, _attachments: unknown[]) => false);
    renderLaunch(onLaunch);
    await stageImage();

    const launch = await screen.findByRole("button", { name: /launch/i });
    await waitFor(() => expect(launch).not.toBeDisabled());
    fireEvent.click(launch);

    expect(onLaunch).toHaveBeenCalledTimes(1);
    // Text + attachments are handed to the caller together.
    expect(onLaunch.mock.calls[0][0]).toBe("describe this screenshot");
    expect(screen.getByText("shot.png")).toBeInTheDocument();
    expect(mocks.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("revokes preview URLs when attachments are removed and on unmount", async () => {
    const onLaunch = vi.fn(() => false);
    const { unmount } = renderLaunch(onLaunch);

    await stageImage("remove-me.png");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("remove-me.png")).not.toBeInTheDocument());
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");

    await stageImage("unmount-me.png");
    unmount();
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
  });

  it("reads and writes its draft in the launch slot of the draft store", () => {
    renderLaunch(vi.fn(() => false));
    const textarea = screen.getByPlaceholderText(/what would you like to work on/i);
    fireEvent.change(textarea, { target: { value: "half-typed launch prompt" } });
    expect(useAgentDraftStore.getState().drafts[LAUNCH_DRAFT_KEY]).toBe("half-typed launch prompt");
  });
});

describe("Composer (chat variant) — per-conversation drafts + send (protected)", () => {
  it("persists the draft under the conversation id with no bleed", () => {
    useAgentDraftStore.getState().setDraft("conv-other", "other draft");
    const conv = makeConversation("conv-1");
    renderChat(conv);

    const textarea = screen.getByPlaceholderText(/do anything/i);
    fireEvent.change(textarea, { target: { value: "typed in conv-1" } });

    const drafts = useAgentDraftStore.getState().drafts;
    expect(drafts["conv-1"]).toBe("typed in conv-1");
    expect(drafts["conv-other"]).toBe("other draft");
    expect(drafts[LAUNCH_DRAFT_KEY]).toBeUndefined();
  });

  it("shows the persisted draft for its conversation on mount", () => {
    useAgentDraftStore.getState().setDraft("conv-1", "restored draft");
    renderChat(makeConversation("conv-1"));
    expect(screen.getByPlaceholderText(/do anything/i)).toHaveValue("restored draft");
  });

  it("Enter sends the trimmed draft through sendMessage and clears it", () => {
    renderChat(makeConversation("conv-1"));
    const textarea = screen.getByPlaceholderText(/do anything/i);
    fireEvent.change(textarea, { target: { value: "  hello agent  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mocks.agentTaskState.sendMessage).toHaveBeenCalledWith("conv-1", "hello agent", null);
    expect(useAgentDraftStore.getState().drafts["conv-1"]).toBeUndefined();
  });

  it("still dispatches to sendMessage while the agent is streaming (store queues it)", () => {
    const conv = makeConversation("conv-1");
    conv.status = "active";
    conv.messages = [
      {
        id: "m-a",
        role: "assistant",
        content: "streaming…",
        timestamp: 1,
        isStreaming: true,
      },
    ];
    renderChat(conv);
    const textarea = screen.getByPlaceholderText(/do anything/i);
    fireEvent.change(textarea, { target: { value: "queue me" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mocks.agentTaskState.sendMessage).toHaveBeenCalledWith("conv-1", "queue me", null);
  });

  it("disables and pulses Stop while terminal cancellation acknowledgement is pending", () => {
    const conv = makeConversation("conv-stopping");
    conv.status = "active";
    conv.messages = [
      {
        id: "m-streaming",
        role: "assistant",
        content: "still winding down",
        timestamp: 1,
        isStreaming: true,
      },
    ];
    mocks.agentTaskState.cancellingConversationIds = new Set([conv.id]);

    const { container } = renderChat(conv);
    const stopIcon = container.querySelector("svg.lucide-square");
    const stopButton = stopIcon?.closest("button");

    expect(stopButton).toBeDisabled();
    expect(stopIcon).toHaveClass("animate-pulse");
    fireEvent.click(stopButton!);
    expect(mocks.agentTaskState.cancelActiveConversation).not.toHaveBeenCalled();
  });
});

/**
 * ACP engine wiring. The engine is reachable ONLY through a conversation that
 * carries an `engineCapabilities` record, and every affordance below still
 * renders from `capabilitiesFor` — the record gates the CALL, not the control.
 * Each case therefore has a twin: what the engine adds, and what happens when
 * it is absent or broken.
 */
describe("Composer (chat variant) — ACP engine surfaces", () => {
  // Same literal `makeConversation` uses — escaped, so it is a real Windows path.
  const PROJECT_PATH = "D:\\projects\\PacketBench";

  function engineCaps(): AcpEngineCapabilities {
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
        mcpList: true,
        mcpDefaults: true,
        permissionModes: ["ask", "read-only"],
        defaultPermissionMode: "read-only",
      },
    };
  }

  function makeEngineConversation(id: string): AgentConversation {
    const conv = makeConversation(id);
    conv.agent = "api-packetcode" as AgentConversation["agent"];
    conv.model = "claude-opus-4-8";
    conv.engineCapabilities = engineCaps();
    return conv;
  }

  function typeInto(value: string) {
    const textarea = screen.getByPlaceholderText(/do anything/i);
    fireEvent.change(textarea, { target: { value } });
    return textarea;
  }

  it("merges the engine's commands into the / menu, hint and all", async () => {
    mocks.acpListCommands.mockResolvedValue([
      {
        name: "cost",
        description: "Session spend so far",
        source: "builtin",
        argumentHint: "[days]",
      },
    ]);
    renderChat(makeEngineConversation("conv-engine-cmds"));
    await waitFor(() =>
      expect(mocks.acpListCommands).toHaveBeenCalledWith(PROJECT_PATH),
    );

    typeInto("/");
    // The argument hint rides on the row, next to the name it belongs to.
    expect(await screen.findByText("/cost [days]")).toBeInTheDocument();
    // PacketBench's own builtins are still there — the engine ADDS to the menu.
    expect(screen.getByText("/permissions")).toBeInTheDocument();
  });

  it("costs a non-engine session no round trip at all", async () => {
    renderChat(makeConversation("conv-plain"));
    typeInto("/");
    expect(await screen.findByText("/permissions")).toBeInTheDocument();
    expect(mocks.acpListCommands).not.toHaveBeenCalled();
  });

  it("keeps the pre-engine menu when the engine cannot list commands", async () => {
    mocks.acpListCommands.mockRejectedValue(new Error("engine not started"));
    renderChat(makeEngineConversation("conv-engine-cmds-fail"));
    await waitFor(() => expect(mocks.acpListCommands).toHaveBeenCalled());

    typeInto("/");
    // Builtins survive; nothing throws into render.
    expect(await screen.findByText("/permissions")).toBeInTheDocument();
    expect(screen.queryByText("/cost")).toBeNull();
  });

  it("serves @ mentions from the engine's project search", async () => {
    mocks.acpSearchFiles.mockResolvedValue(["src/lib/tauri.ts"]);
    renderChat(makeEngineConversation("conv-engine-files"));

    typeInto("@tau");
    expect(await screen.findByText("src/lib/tauri.ts")).toBeInTheDocument();
    expect(mocks.acpSearchFiles).toHaveBeenCalledWith(PROJECT_PATH, "tau");
  });

  it("renders engine-reported usage in the statusline", async () => {
    // The ACP transport emits no per-turn summary, so the message roll-up has
    // nothing to add up — the numbers can only come from the query.
    mocks.acpSessionUsage.mockResolvedValue({
      contextTokens: 41_200,
      totalInput: 82_000,
      totalOutput: 12_000,
      costUsd: 1.84,
    });
    renderChat(makeEngineConversation("conv-engine-usage"));

    expect(
      await screen.findByText("ctx 41.2k tok · in 82k · out 12k"),
    ).toBeInTheDocument();
    expect(mocks.acpSessionUsage).toHaveBeenCalledWith("conv-engine-usage");
  });

  it("does not query usage while a turn is still running", async () => {
    const conv = makeEngineConversation("conv-engine-active");
    conv.status = "active";
    renderChat(conv);
    await waitFor(() => expect(mocks.acpListCommands).toHaveBeenCalled());
    expect(mocks.acpSessionUsage).not.toHaveBeenCalled();
  });

  it("shows no statusline when the usage query fails", async () => {
    mocks.acpSessionUsage.mockRejectedValue(new Error("engine not started"));
    renderChat(makeEngineConversation("conv-engine-usage-fail"));
    await waitFor(() => expect(mocks.acpSessionUsage).toHaveBeenCalled());
    expect(screen.queryByText(/^ctx /)).toBeNull();
  });
});
