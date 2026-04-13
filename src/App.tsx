import { useEffect, useCallback, lazy, Suspense } from "react";
import { TitleBar } from "@/components/layout/TitleBar";
import { Toolbar } from "@/components/layout/Toolbar";
import { MosaicContainer } from "@/components/layout/MosaicContainer";
import { StatusBar } from "@/components/layout/StatusBar";
import { WelcomeScreen } from "@/components/views/WelcomeScreen";
import { CommandPalette } from "@/components/common/CommandPalette";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMosaicStore } from "@/stores/mosaicStore";
import { useAppStore, getModuleId } from "@/stores/appStore";
import { useModuleStore } from "@/stores/moduleStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { getModule } from "@/modules/registry";
import { useStatusLinePoller, useCodexStatusLinePoller, useGeminiStatusLinePoller, useOpenCodeStatusLinePoller } from "@/hooks/useStatusLine";
import { initializeApp, persistUiState } from "@/lib/bootstrap";
import type { AppView } from "@/stores/appStore";

// Lazy-loaded views — split into separate chunks to reduce initial bundle size
const IssueBoard = lazy(() => import("@/components/issues/IssueBoard").then((m) => ({ default: m.IssueBoard })));
const HistoryView = lazy(() => import("@/components/views/HistoryView").then((m) => ({ default: m.HistoryView })));
const ToolsView = lazy(() => import("@/components/views/ToolsView").then((m) => ({ default: m.ToolsView })));
const GitHubView = lazy(() => import("@/components/views/GitHubView").then((m) => ({ default: m.GitHubView })));
const MemoryView = lazy(() => import("@/components/views/MemoryView").then((m) => ({ default: m.MemoryView })));
const DeployView = lazy(() => import("@/components/views/DeployView").then((m) => ({ default: m.DeployView })));
const ReviewQueueView = lazy(() => import("@/components/views/ReviewQueueView").then((m) => ({ default: m.ReviewQueueView })));
const WorkspaceView = lazy(() => import("@/components/views/WorkspaceView").then((m) => ({ default: m.WorkspaceView })));
const FlightDeckView = lazy(() => import("@/components/views/FlightDeckView").then((m) => ({ default: m.FlightDeckView })));
const ServersView = lazy(() => import("@/components/views/ServersView").then((m) => ({ default: m.ServersView })));

function ViewLoader() {
  return (
    <div className="flex flex-1 items-center justify-center text-xs text-text-secondary">
      Loading…
    </div>
  );
}

export default function App() {
  const addPane = useLayoutStore((s) => s.addPane);
  const panes = useLayoutStore((s) => s.panes);
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const theme = useAppStore((s) => s.theme);
  // Poll status line data for all agents
  useStatusLinePoller();
  useCodexStatusLinePoller();
  useGeminiStatusLinePoller();
  useOpenCodeStatusLinePoller();

  // Bootstrap: load backend state and hydrate all stores on first mount
  useEffect(() => {
    initializeApp();
  }, []);

  // Apply theme class to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Persist pane count to localStorage
  useEffect(() => {
    localStorage.setItem("packetcode:pane-count", String(panes.length));
  }, [panes.length]);

  // Persist project path to localStorage and record in history
  const projectPath = useLayoutStore((s) => s.projectPath);
  useEffect(() => {
    if (!projectPath) return;
    localStorage.setItem("packetcode:project-path", projectPath);
    useProjectHistoryStore.getState().recordOpen(projectPath);
  }, [projectPath]);

  // Persist UI state (active view, theme) to backend on change
  useEffect(() => {
    // Skip initial render before bootstrap completes
    if (!useAppStore.getState().initialized) return;
    persistUiState();
  }, [activeView, theme]);

  // Guard: if active view is a disabled module, redirect to tools
  useEffect(() => {
    const modId = getModuleId(activeView);
    if (modId && !useModuleStore.getState().isEnabled(modId)) {
      setActiveView("tools");
    }
  }, [activeView, setActiveView]);

  // Listen for new session requests
  useEffect(() => {
    function handleNewSession() {
      const view = useAppStore.getState().activeView;
      if (view !== "claude" && view !== "codex") {
        useAppStore.getState().setActiveView("claude");
      }
      useLayoutStore.getState().addPane({ cliCommand: "claude" });
    }

    function handleNewCodexSession() {
      if (useAppStore.getState().activeView !== "codex") {
        useAppStore.getState().setActiveView("codex");
      }
      useLayoutStore.getState().addPane({ cliCommand: "codex" });
    }

    window.addEventListener("packetcode:new-session", handleNewSession);
    window.addEventListener("packetcode:new-codex-session", handleNewCodexSession);
    return () => {
      window.removeEventListener("packetcode:new-session", handleNewSession);
      window.removeEventListener("packetcode:new-codex-session", handleNewCodexSession);
    };
  }, []);

  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);

  // Global keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ctrl+K to open command palette
      if (e.ctrlKey && e.key === "k") {
        e.preventDefault();
        useAppStore.getState().setCommandPaletteOpen(
          !useAppStore.getState().commandPaletteOpen
        );
        return;
      }
      // Escape to close command palette
      if (e.key === "Escape" && useAppStore.getState().commandPaletteOpen) {
        e.preventDefault();
        useAppStore.getState().setCommandPaletteOpen(false);
        return;
      }
      // Ctrl+\ to split pane
      if (e.ctrlKey && e.key === "\\") {
        e.preventDefault();
        const view = useAppStore.getState().activeView;
        const cli = view === "codex" ? "codex" : "claude";
        addPane({ cliCommand: cli });
      }
      // Ctrl+1/2/3/4 to switch panes (uses mosaic leaf order for spatial consistency)
      if (e.ctrlKey && !e.shiftKey && e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        const orderedIds = useMosaicStore.getState().getLeafOrder();
        const idx = parseInt(e.key) - 1;
        if (idx < orderedIds.length) {
          useLayoutStore.getState().setActivePaneId(orderedIds[idx]);
        }
      }
      // Ctrl+Shift+1/2/3/4/5/6 to switch views
      if (e.ctrlKey && e.shiftKey) {
        // Ctrl+Shift+W → Workspace view
        if (e.key === "W") {
          e.preventDefault();
          setActiveView("workspace");
          return;
        }
        const viewMap: Record<string, AppView> = {
          "!": "claude",    // Shift+1
          "@": "codex",     // Shift+2
          "#": "issues",    // Shift+3
          "$": "history",   // Shift+4
          "%": "tools",     // Shift+5
        };
        if (viewMap[e.key]) {
          e.preventDefault();
          setActiveView(viewMap[e.key]);
        }
      }
    },
    [addPane, setActiveView]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const isSessionsView = activeView === "claude" || activeView === "codex" || activeView === "gemini" || activeView === "opencode";
  const showWorkspaceSidebar = activeView === "workspace" || activeView === "flight_deck" || activeView === "servers" || activeView === "issues" || activeView === "history";

  return (
    <ErrorBoundary fallbackMessage="PacketCode encountered an error">
      <div className="flex flex-col h-screen bg-bg-primary text-text-primary font-sans">
        <TitleBar />
        <Toolbar />
        <div className="flex flex-1 overflow-hidden">
          {/* Main content area */}
          <div className="flex flex-col flex-1 overflow-hidden">
            <ErrorBoundary fallbackMessage="View error">
              {/* Welcome screen */}
              {activeView === "welcome" && (
                <div className="flex flex-col flex-1 overflow-hidden">
                  <WelcomeScreen />
                </div>
              )}
              {/* Mosaic tiling container for CLI sessions */}
              <div
                className="flex flex-col flex-1 overflow-hidden"
                style={{ display: isSessionsView ? "flex" : "none" }}
              >
                <MosaicContainer />
              </div>
              {/* Workspace view — always mounted so PTY sessions stay
                  alive when the user navigates to other tabs. */}
              <div
                className="flex flex-col flex-1 overflow-hidden"
                style={{ display: activeView === "workspace" ? "flex" : "none" }}
              >
                <Suspense fallback={<ViewLoader />}>
                  <WorkspaceView />
                </Suspense>
              </div>
              {/* Other views render conditionally */}
              <Suspense fallback={<ViewLoader />}>
                <OtherViewContent activeView={activeView} />
              </Suspense>
            </ErrorBoundary>
          </div>

          {/* Workspace sidebar — persistent across core views */}
          {showWorkspaceSidebar && <WorkspaceSidebar />}
        </div>
        <StatusBar />
        {commandPaletteOpen && <CommandPalette />}
      </div>
    </ErrorBoundary>
  );
}

function OtherViewContent({ activeView }: { activeView: AppView }) {
  const moduleStates = useModuleStore((s) => s.states);
  const isModuleEnabled = (id: string) => moduleStates[id]?.enabled ?? false;

  switch (activeView) {
    case "welcome":
      return null; // rendered above
    case "issues":
      return <IssueBoard />;
    case "flight_deck":
      return <FlightDeckView />;
    case "servers":
      return <ServersView />;
    case "history":
      return <HistoryView />;
    case "tools":
      return <ToolsView />;
    case "github":
      return <GitHubView />;
    case "memory":
      return <MemoryView />;
    case "deploy":
      return <DeployView />;
    case "review_queue":
      return <ReviewQueueView />;
    case "workspace":
      return null; // rendered above as an always-mounted view
  }

  // Module views — dynamic lookup
  const modId = getModuleId(activeView);
  if (!modId) return null;
  const mod = getModule(modId);
  if (!mod || !isModuleEnabled(modId)) return null;
  const ModComponent = mod.component;
  return (
    <ErrorBoundary fallbackMessage={`${mod.name} encountered an error`}>
      <ModComponent />
    </ErrorBoundary>
  );
}
