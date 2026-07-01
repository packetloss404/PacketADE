import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentInputArea } from "@/components/agents/AgentInputArea";
import type { AgentCli } from "@/stores/agentTaskStore";

const mocks = vi.hoisted(() => ({
  agentTaskState: {
    agentInputText: "describe this screenshot",
    selectedRepo: "D:\\projects\\PacketADE",
    selectedConversationId: null as string | null,
    setAgentInputText: vi.fn(),
    setSelectedRepo: vi.fn(),
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
    apiAgentProvider: (agent: AgentCli) => agent.replace(/^api-/, ""),
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
}));

function renderInput(onLaunch: (attachments: unknown[]) => boolean) {
  return render(
    <AgentInputArea
      textareaRef={createRef<HTMLTextAreaElement>()}
      selectedAgent="api-minimax"
      onAgentChange={vi.fn()}
      onLaunch={onLaunch}
      selectedModel="MiniMax-M2.5"
      onModelChange={vi.fn()}
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

describe("AgentInputArea image attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentTaskState.agentInputText = "describe this screenshot";
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

  it("keeps staged images when launch is rejected as a no-op", async () => {
    const onLaunch = vi.fn(() => false);
    renderInput(onLaunch);
    await stageImage();

    const launch = await screen.findByRole("button", { name: /launch/i });
    await waitFor(() => expect(launch).not.toBeDisabled());
    fireEvent.click(launch);

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("shot.png")).toBeInTheDocument();
    expect(mocks.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("revokes preview URLs when attachments are removed and on unmount", async () => {
    const onLaunch = vi.fn(() => false);
    const { unmount } = renderInput(onLaunch);

    await stageImage("remove-me.png");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("remove-me.png")).not.toBeInTheDocument());
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");

    await stageImage("unmount-me.png");
    unmount();
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
  });
});
