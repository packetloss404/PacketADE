/**
 * The sidebar's engine-session directory.
 *
 * The design question this file pins down: an engine session and a PacketBench
 * conversation are NOT the same object. A conversation owns a full local
 * transcript and opens into the chat pane; an engine session is a remote
 * handle — a name, a timestamp, a model and a message count — whose transcript
 * lives in the engine and stays there. Rendering them in one list would make a
 * row that cannot be opened look exactly like a row that can, so they are two
 * lists, and the engine one says what it is.
 *
 * Opening an engine row ADOPTS it: a new conversation is bound to the engine's
 * session id and the first message resumes it over ACP `session/load`. That is
 * offered only where the engine advertised the spec `loadSession` capability —
 * an engine that cannot resume leaves the directory exactly as read-only as it
 * was — and adopting never claims to have the history: the engine's load
 * replay omits the user's own turns, so nothing of it is rendered and the
 * adopted conversation says so.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The partial store mock pulls in the real `agentTaskStore` module graph, whose
// cold import costs seconds on Windows under parallel suite load.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const engineStore = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));

// Partial mock: `engineDirectoryRecord` (and every other export the sidebar
// reaches for) keeps its real implementation, so the capability descriptor
// under test is the real one. Only the hook is swapped for a fixture.
vi.mock("@/stores/agentTaskStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/agentTaskStore")>()),
  useAgentTaskStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(engineStore.state),
    { getState: () => engineStore.state },
  ),
}));

import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentSidebarPrefsStore } from "@/stores/agentSidebarPrefsStore";
import type { AcpEngineCapabilities, AcpSessionSummary } from "@/lib/tauri";
import type { AgentConversation } from "@/types/agent-conversation";

function engineCaps(
  over: Partial<AcpEngineCapabilities["packetcode"]> = {},
): AcpEngineCapabilities {
  return {
    protocolVersion: 1,
    loadSession: true,
    sessionClose: true,
    packetcode: {
      advertised: true,
      sessionsList: true,
      sessionsRename: true,
      sessionsUsage: true,
      modelsList: false,
      mcpList: true,
      mcpDefaults: true,
      permissionModes: ["ask", "read-only"],
      defaultPermissionMode: "read-only",
      ...over,
    },
  };
}

function engineSession(over: Partial<AcpSessionSummary> = {}): AcpSessionSummary {
  return {
    sessionId: "eng-1",
    name: "Refactor the router",
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    provider: "anthropic",
    model: "claude-opus-4-8",
    workingDir: "D:/projects/example",
    messageCount: 12,
    costUsd: 0.42,
    ...over,
  };
}

function conversation(over: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Local conversation",
    agent: "api-packetcode",
    projectPath: "D:/projects/example",
    status: "idle",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 10,
    mode: "api",
    provider: "packetcode-acp",
    model: "claude-opus-4-8",
    ...over,
  } as AgentConversation;
}

const renameConversation = vi.fn();
const pushEngineRename = vi.fn();
const renameEngineSession = vi.fn();
const refreshEngineSessions = vi.fn().mockResolvedValue(undefined);
const adoptEngineSession = vi.fn().mockResolvedValue("conv-adopted");

function seedStore(over: Record<string, unknown> = {}) {
  engineStore.state = {
    conversations: [conversation()],
    deleteConversation: vi.fn(),
    archiveConversation: vi.fn(),
    unarchiveConversation: vi.fn(),
    renameConversation,
    pushEngineRename,
    renameEngineSession,
    refreshEngineSessions,
    adoptEngineSession,
    engineSessions: [engineSession()],
    engineSessionsStatus: "ready",
    engineCapabilities: engineCaps(),
    ...over,
  };
}

function expand() {
  fireEvent.click(screen.getByRole("button", { name: /on the engine/i }));
}

describe("AgentSidebar — engine session directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedStore();
    useAgentApprovalStore.setState({ permissions: new Map(), edits: new Map() });
    useAgentSidebarPrefsStore.setState({ prefs: {}, projectLabels: {} });
  });

  it("is absent on the general Agents route", () => {
    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} />);

    expect(screen.queryByText(/on the engine/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Refactor the router")).not.toBeInTheDocument();
  });

  it("starts collapsed and only asks the engine when the user opens it", () => {
    // Expanding starts a subprocess (`acp_start`), so it must be something the
    // user asked for, never a side effect of rendering a sidebar.
    seedStore({ engineSessionsStatus: "idle", engineSessions: [] });
    render(
      <AgentSidebar
        selectedId={null}
        onSelect={vi.fn()}
        onNewAgent={vi.fn()}
        showEngineSessions
      />,
    );

    expect(refreshEngineSessions).not.toHaveBeenCalled();
    expect(screen.queryByText("Refactor the router")).not.toBeInTheDocument();

    expand();

    expect(refreshEngineSessions).toHaveBeenCalled();
  });

  it("keeps engine rows out of the conversation list", () => {
    render(
      <AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} showEngineSessions />,
    );
    expand();

    // Two lists, two headings. The engine row never appears among the
    // project-grouped conversations above it.
    expect(screen.getByText("Local conversation")).toBeInTheDocument();
    expect(screen.getByText("Refactor the router")).toBeInTheDocument();
    expect(screen.getByText(/on the engine/i)).toBeInTheDocument();
  });

  it("adopts an engine row and opens the conversation the adoption created", async () => {
    const onSelect = vi.fn();
    render(
      <AgentSidebar selectedId={null} onSelect={onSelect} onNewAgent={vi.fn()} showEngineSessions />,
    );
    expand();

    const engineRow = screen.getByText("Refactor the router");
    expect(engineRow.closest("button")).not.toBeNull();

    fireEvent.click(engineRow);

    expect(adoptEngineSession).toHaveBeenCalledWith("eng-1");
    // The adoption resolves the new conversation id; opening it is the second
    // half of the same gesture.
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("conv-adopted"));
  });

  it("leaves the row un-openable when the engine cannot load a session", () => {
    // `loadSession` is the ACP SPEC capability. Without it a resume is
    // impossible, so a clickable row would be a control whose every use fails
    // — the silent no-op the capability rule exists to prevent.
    seedStore({ engineCapabilities: { ...engineCaps(), loadSession: false } });
    const onSelect = vi.fn();
    render(
      <AgentSidebar selectedId={null} onSelect={onSelect} onNewAgent={vi.fn()} showEngineSessions />,
    );
    expand();

    const engineRow = screen.getByText("Refactor the router");
    expect(engineRow.closest("button")).toBeNull();
    fireEvent.click(engineRow);
    expect(adoptEngineSession).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be opened here/i)).toBeInTheDocument();
  });

  it("says plainly that it holds no transcript for these sessions", () => {
    render(
      <AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} showEngineSessions />,
    );
    expand();

    // Openable, and still explicit that the transcript is not coming with it.
    expect(screen.getByText(/PacketBench has no transcript for it/i)).toBeInTheDocument();
  });

  it("distinguishes an empty engine from an unreachable one", () => {
    seedStore({ engineSessions: [], engineSessionsStatus: "ready" });
    const { unmount } = render(
      <AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} showEngineSessions />,
    );
    expand();
    expect(screen.getByText(/holding no sessions/i)).toBeInTheDocument();
    unmount();

    seedStore({ engineSessions: [], engineSessionsStatus: "unavailable" });
    render(
      <AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} showEngineSessions />,
    );
    expand();
    expect(screen.getByText(/its history is unknown/i)).toBeInTheDocument();
    expect(screen.queryByText(/holding no sessions/i)).not.toBeInTheDocument();
  });

  it("renames an engine row through the engine", () => {
    render(
      <AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} showEngineSessions />,
    );
    expand();

    fireEvent.doubleClick(screen.getByText("Refactor the router"));
    const input = screen.getByLabelText("Rename engine session");
    fireEvent.change(input, { target: { value: "Renamed remotely" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(renameEngineSession).toHaveBeenCalledWith("eng-1", "Renamed remotely");
  });

  it("withholds the engine rename when the engine cannot serve it", () => {
    // `_packetcode/sessions/rename` degrades to a silent success, so without
    // the capability the rename would simply be undone by the next listing —
    // exactly the no-op affordance the capability rule exists to prevent.
    seedStore({ engineCapabilities: engineCaps({ sessionsRename: false }) });
    render(
      <AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} showEngineSessions />,
    );
    expand();

    fireEvent.doubleClick(screen.getByText("Refactor the router"));

    expect(screen.queryByLabelText("Rename engine session")).not.toBeInTheDocument();
    expect(screen.getByText(/renaming is unavailable/i)).toBeInTheDocument();
  });
});

describe("AgentSidebar — conversation rename reaches the engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedStore();
    useAgentApprovalStore.setState({ permissions: new Map(), edits: new Map() });
    useAgentSidebarPrefsStore.setState({ prefs: {}, projectLabels: {} });
  });

  function renameLocal(to: string) {
    fireEvent.doubleClick(screen.getByText("Local conversation"));
    const input = screen.getByLabelText("Rename conversation");
    fireEvent.change(input, { target: { value: to } });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("writes locally first, then pushes the name out to the engine", () => {
    seedStore({
      conversations: [conversation({ engineCapabilities: engineCaps() })],
    });
    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} />);

    renameLocal("Renamed");

    expect(renameConversation).toHaveBeenCalledWith("conv-1", "Renamed");
    expect(pushEngineRename).toHaveBeenCalledWith("conv-1", "Renamed");
  });

  it("does not offer the rename at all when the engine cannot keep it", () => {
    seedStore({
      conversations: [
        conversation({ engineCapabilities: engineCaps({ sessionsRename: false }) }),
      ],
    });
    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} />);

    fireEvent.doubleClick(screen.getByText("Local conversation"));

    expect(screen.queryByLabelText("Rename conversation")).not.toBeInTheDocument();
    expect(renameConversation).not.toHaveBeenCalled();
  });

  it("leaves non-ACP renames purely local", () => {
    // No engine record at all → `canRename` is the pre-ACP `true`, and the
    // store action's own transport check keeps the push a no-op.
    seedStore({
      conversations: [conversation({ agent: "api-openai", provider: "openai" })],
    });
    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} />);

    renameLocal("Renamed");

    expect(renameConversation).toHaveBeenCalledWith("conv-1", "Renamed");
    expect(pushEngineRename).toHaveBeenCalledWith("conv-1", "Renamed");
  });
});
