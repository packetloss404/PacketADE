import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/agents/composer/Composer";
import { LAUNCH_DRAFT_KEY, useAgentDraftStore } from "@/stores/agentDraftStore";
import type { AgentConversation } from "@/types/agent-conversation";

const mocks = vi.hoisted(() => ({
  agentTaskState: {
    selectedRepo: "D:\\projects\\PacketADE" as string | null,
    selectedConversationId: null as string | null,
    conversations: [] as unknown[],
    setSelectedRepo: vi.fn(),
    sendMessage: vi.fn(),
    cancelActiveConversation: vi.fn(),
    createApiConversation: vi.fn(),
    selectConversation: vi.fn(),
    setPlanMode: vi.fn(),
  },
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
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
  return {
    useAgentTaskStore,
    apiAgentProvider: (agent: string) => agent.replace(/^api-/, ""),
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
    (selector: (state: {
      servers: unknown[];
      updateServer: () => void;
    }) => unknown) =>
      selector({ servers: [], updateServer: vi.fn() }),
  ),
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: vi.fn(
    (selector: (state: { setActiveView: () => void }) => unknown) =>
      selector({ setActiveView: vi.fn() }),
  ),
}));

vi.mock("@/stores/promptStore", () => ({
  usePromptStore: vi.fn(
    (selector: (state: { templates: unknown[] }) => unknown) =>
      selector({ templates: [] }),
  ),
}));

vi.mock("@/stores/profileStore", () => ({
  useProfileStore: vi.fn(
    (selector: (state: {
      profiles: Array<{ id: string; name: string; description: string; isBuiltin: boolean }>;
      defaultProfileId: string;
      setDefaultProfile: () => void;
    }) => unknown) =>
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
    projectPath: "D:\\projects\\PacketADE",
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
  mocks.agentTaskState.selectedRepo = "D:\\projects\\PacketADE";
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
    useAgentDraftStore
      .getState()
      .setDraft(LAUNCH_DRAFT_KEY, "describe this screenshot");
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
    expect(useAgentDraftStore.getState().drafts[LAUNCH_DRAFT_KEY]).toBe(
      "half-typed launch prompt",
    );
  });
});

describe("Composer (chat variant) — per-conversation drafts + send (protected)", () => {
  it("persists the draft under the conversation id with no bleed", () => {
    useAgentDraftStore.getState().setDraft("conv-other", "other draft");
    const conv = makeConversation("conv-1");
    renderChat(conv);

    const textarea = screen.getByPlaceholderText(/send a message/i);
    fireEvent.change(textarea, { target: { value: "typed in conv-1" } });

    const drafts = useAgentDraftStore.getState().drafts;
    expect(drafts["conv-1"]).toBe("typed in conv-1");
    expect(drafts["conv-other"]).toBe("other draft");
    expect(drafts[LAUNCH_DRAFT_KEY]).toBeUndefined();
  });

  it("shows the persisted draft for its conversation on mount", () => {
    useAgentDraftStore.getState().setDraft("conv-1", "restored draft");
    renderChat(makeConversation("conv-1"));
    expect(screen.getByPlaceholderText(/send a message/i)).toHaveValue(
      "restored draft",
    );
  });

  it("Enter sends the trimmed draft through sendMessage and clears it", () => {
    renderChat(makeConversation("conv-1"));
    const textarea = screen.getByPlaceholderText(/send a message/i);
    fireEvent.change(textarea, { target: { value: "  hello agent  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mocks.agentTaskState.sendMessage).toHaveBeenCalledWith(
      "conv-1",
      "hello agent",
      null,
    );
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
    const textarea = screen.getByPlaceholderText(/send a message/i);
    fireEvent.change(textarea, { target: { value: "queue me" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mocks.agentTaskState.sendMessage).toHaveBeenCalledWith(
      "conv-1",
      "queue me",
      null,
    );
  });
});
