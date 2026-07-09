import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftTile } from "@/components/workspace/DraftTile";
import { useDraftTileStore } from "@/stores/draftTileStore";
import { useAgentDraftStore } from "@/stores/agentDraftStore";
import { flagsForMode } from "@/components/agents/agentModeChipUtils";
import type { LaunchConversationParams } from "@/lib/launchConversation";
import type { Workspace } from "@/types/workspace";

/**
 * DraftTile (P3-S4): the first-run draft conversation tile. Verifies the
 * capability-filtered mode chip (Codex → sandbox vocabulary only), draft-text
 * persistence via agentDraftStore, and the send flow — launchConversation with
 * an explicit postureOverride, then materialization (addConversationPane) and
 * draft retirement (chips "fold into the header").
 */

const launchMock = vi.fn();
const addConversationPane = vi.fn(() => "ws-pane-mat");

// M1(a): the default profile the tile resolves at send time. Tests mutate this
// to prove the profile's memory flag reaches launchConversation.
let defaultProfile: {
  id: string;
  memoryContextEnabled: boolean;
  systemPrompt: string;
  allowedTools: string[] | null;
} = {
  id: "builtin-default",
  memoryContextEnabled: false,
  systemPrompt: "",
  allowedTools: null,
};

vi.mock("@/stores/profileStore", () => ({
  useProfileStore: Object.assign(vi.fn(), {
    getState: () => ({ getDefaultProfile: () => defaultProfile }),
  }),
}));

vi.mock("@/lib/launchConversation", () => ({
  launchConversation: (params: LaunchConversationParams) => launchMock(params),
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: Object.assign(vi.fn(), {
    getState: () => ({ addConversationPane }),
  }),
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: vi.fn(
    (selector: (s: { activePaneId: string | null; setActivePaneId: () => void }) => unknown) =>
      selector({ activePaneId: null, setActivePaneId: vi.fn() }),
  ),
}));

const workspace: Workspace = {
  id: "ws-1",
  name: "WS",
  agents: [],
  panes: [],
  projectPath: "/tmp/project",
  createdAt: 1,
  updatedAt: 1,
  status: "active",
};

function seedDraft(agent: string, model = "m", mode: "default" = "default"): string {
  return useDraftTileStore
    .getState()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addDraft(workspace.id, agent as any, model, mode);
}

describe("DraftTile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDraftTileStore.setState({ drafts: [] });
    useAgentDraftStore.setState({ drafts: {} });
    defaultProfile = {
      id: "builtin-default",
      memoryContextEnabled: false,
      systemPrompt: "",
      allowedTools: null,
    };
  });

  it("renders the sparkle first-run face", () => {
    const id = seedDraft("api-claude", "claude-opus-4-8");
    render(<DraftTile draftId={id} workspace={workspace} />);
    expect(screen.getByText("Describe the task to start")).toBeInTheDocument();
    expect(screen.getByText("Claude API")).toBeInTheDocument();
  });

  it("filters the mode chip to honorable sandbox postures for Codex (no approval-implying modes)", () => {
    const id = seedDraft("api-openai-codex", "gpt-5.5");
    render(<DraftTile draftId={id} workspace={workspace} />);
    // The selected posture reads in sandbox vocabulary, not "Default".
    fireEvent.click(screen.getByRole("button", { name: /workspace-write/i }));
    expect(screen.getByRole("button", { name: "Read-only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Full access" })).toBeInTheDocument();
    // Approval-implying postures are filtered out entirely.
    expect(screen.queryByText("Manual")).not.toBeInTheDocument();
    expect(screen.queryByText("Deny")).not.toBeInTheDocument();
  });

  it("keeps the full approval-capable mode set for a normal provider", () => {
    const id = seedDraft("api-claude", "claude-opus-4-8");
    render(<DraftTile draftId={id} workspace={workspace} />);
    fireEvent.click(screen.getByRole("button", { name: /default/i }));
    expect(screen.getByRole("button", { name: "Manual" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("persists the task text via agentDraftStore (keyed by draft id)", () => {
    const id = seedDraft("api-claude");
    render(<DraftTile draftId={id} workspace={workspace} />);
    fireEvent.change(screen.getByPlaceholderText("Describe the task…"), {
      target: { value: "ship the feature" },
    });
    expect(useAgentDraftStore.getState().drafts[id]).toBe("ship the feature");
  });

  it("on first send launches with the posture override, materializes a pane, and retires the draft", () => {
    // The mock plays the launcher's role: fire onLaunched with a fresh conv id.
    launchMock.mockImplementation((params: LaunchConversationParams) => {
      params.onLaunched?.("conv-new");
      return true;
    });

    const id = seedDraft("api-claude", "claude-opus-4-8");
    render(<DraftTile draftId={id} workspace={workspace} />);
    fireEvent.change(screen.getByPlaceholderText("Describe the task…"), {
      target: { value: "do it" },
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /send/i }));
    });

    expect(launchMock).toHaveBeenCalledTimes(1);
    const params = launchMock.mock.calls[0][0] as LaunchConversationParams;
    expect(params.selectedAgent).toBe("api-claude");
    expect(params.selectedModel).toBe("claude-opus-4-8");
    expect(params.selectedRepo).toBe("/tmp/project");
    expect(params.postureOverride).toEqual(flagsForMode("default"));

    // Created-before-insert: the pane is materialized against the new conv id...
    expect(addConversationPane).toHaveBeenCalledWith("ws-1", "conv-new");
    // ...and the draft (its footer chips) is gone — folded into the tile header.
    expect(useDraftTileStore.getState().drafts).toHaveLength(0);
    expect(useAgentDraftStore.getState().drafts[id]).toBeUndefined();
  });

  it("M1(a): passes the resolved default profile through so a memory-enabled profile reaches the launcher", () => {
    // The Agent Profiles memory checkbox flips this flag on the default
    // profile; the tile launch must carry that profile (not a hardcoded
    // `undefined`) so createApiConversation actually composes a brief.
    defaultProfile = {
      id: "builtin-default",
      memoryContextEnabled: true,
      systemPrompt: "harness prompt",
      allowedTools: null,
    };

    const id = seedDraft("api-claude", "claude-opus-4-8");
    render(<DraftTile draftId={id} workspace={workspace} />);
    fireEvent.change(screen.getByPlaceholderText("Describe the task…"), {
      target: { value: "do it" },
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /send/i }));
    });

    const params = launchMock.mock.calls[0][0] as LaunchConversationParams;
    expect(params.profile).toBeDefined();
    expect(params.profile?.memoryContextEnabled).toBe(true);
    expect(params.profile?.id).toBe("builtin-default");
  });
});
