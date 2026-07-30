/**
 * App shell — right-panel ownership boundary (audit P0-1 / decision D1).
 *
 * The Agent Inspector is owned solely by the Agents view. A conversation
 * selected globally in `agentTaskStore` must NOT cause the app shell to mount
 * `AgentInspectorPane` beside the Workspace surface — the selected
 * conversation may have nothing to do with the active Workspace.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  activeView: "workspace" as string,
  setActiveView: vi.fn(),
  theme: "dark",
  initialized: false,
  commandPaletteOpen: false,
  setCommandPaletteOpen: vi.fn(),
}));

const layoutState = vi.hoisted(() => ({
  projectPath: null as string | null,
}));

const moduleState = vi.hoisted(() => ({
  states: {} as Record<string, { enabled: boolean }>,
  isEnabled: () => true,
}));

const dictationState = vi.hoisted(() => ({
  isStarting: false,
  isRecording: false,
  cancelRecording: vi.fn(),
}));

// A conversation IS selected globally — the exact condition that used to
// (incorrectly) mount AgentInspectorPane beside Workspace from App.
const agentState = vi.hoisted(() => ({
  selectedConversationId: "conv-unrelated" as string | null,
  conversations: [] as unknown[],
}));

const makeStoreMock = vi.hoisted(
  () =>
    function makeStoreMock<S>(state: S) {
      const useStore = (selector: (s: S) => unknown) => selector(state);
      useStore.getState = () => state;
      return useStore;
    },
);

vi.mock("@/stores/appStore", () => ({
  useAppStore: makeStoreMock(appState),
  getModuleId: () => null,
}));
vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: makeStoreMock(layoutState),
}));
vi.mock("@/stores/moduleStore", () => ({
  useModuleStore: makeStoreMock(moduleState),
}));
vi.mock("@/stores/dictationStore", () => ({
  useDictationStore: makeStoreMock(dictationState),
}));
vi.mock("@/stores/projectHistoryStore", () => ({
  useProjectHistoryStore: makeStoreMock({ recordOpen: vi.fn() }),
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: makeStoreMock(agentState),
}));

vi.mock("@/stores/sessionGlue", () => ({ initSessionGlue: vi.fn() }));
vi.mock("@/lib/bootstrap", () => ({
  initializeApp: vi.fn().mockResolvedValue(undefined),
  persistUiState: vi.fn(),
}));
vi.mock("@/lib/mcpWriteBridge", () => ({
  startMcpWriteBridge: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@/lib/flightCoordination", () => ({ startStallSweep: () => () => {} }));
vi.mock("@/lib/notifications", () => ({
  requestNotificationPermission: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/modules/registry", () => ({ getModule: () => undefined }));

vi.mock("@/hooks/useSideChatHotkey", () => ({ useSideChatHotkey: () => {} }));
vi.mock("@/hooks/useDictationTarget", () => ({ useDictationTarget: () => {} }));
vi.mock("@/hooks/useDictationGlobalShortcuts", () => ({
  useDictationGlobalShortcuts: () => {},
}));
vi.mock("@/hooks/useIssueFlightMirrorPoller", () => ({
  useIssueFlightMirrorPoller: () => {},
}));
vi.mock("@/hooks/useMonitorMainRouter", () => ({ useMonitorMainRouter: () => {} }));
vi.mock("@/hooks/useAgentTabHoists", () => ({ useAgentTabHoists: () => {} }));
vi.mock("@/hooks/useStatusLine", () => ({
  useStatusLinePoller: () => {},
  useCodexStatusLinePoller: () => {},
  useOpenCodeStatusLinePoller: () => {},
}));

vi.mock("@/components/layout/TitleBar", () => ({ TitleBar: () => null }));
vi.mock("@/components/layout/Toolbar", () => ({ Toolbar: () => null }));
vi.mock("@/components/layout/LeftRail", () => ({ LeftRail: () => null }));
vi.mock("@/components/layout/StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("@/components/views/WelcomeScreen", () => ({ WelcomeScreen: () => null }));
vi.mock("@/components/common/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/agents/SideChatOverlay", () => ({ SideChatOverlay: () => null }));
vi.mock("@/components/agents/PinnedApprovalBanner", () => ({
  PinnedApprovalBanner: () => null,
}));
vi.mock("@/components/workspace/FleetSidebar", () => ({
  FleetSidebar: () => <div data-testid="fleet-sidebar" />,
}));
vi.mock("@/components/views/WorkspaceView", () => ({
  WorkspaceView: () => <div data-testid="workspace-view" />,
}));

// If a regression ever re-mounts the inspector from App, this mock renders a
// findable marker and the assertion below fails.
vi.mock("@/components/agents/AgentInspectorPane", () => ({
  AgentInspectorPane: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="agent-inspector">{conversationId}</div>
  ),
}));

import App from "@/App";

describe("App shell — inspector ownership (D1)", () => {
  it("does not mount AgentInspectorPane beside Workspace when a conversation is selected globally", async () => {
    render(<App />);

    // Workspace surface (and its sidebar) are up…
    expect(await screen.findByTestId("workspace-view")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-sidebar")).toBeInTheDocument();

    // …but no Agent inspector, despite agentTaskStore.selectedConversationId
    // being set. The Inspector belongs to the Agents view alone.
    expect(screen.queryByTestId("agent-inspector")).toBeNull();
  });
});
