import { useEffect, useCallback, useRef, useState, lazy, Suspense } from "react";
import { TitleBar } from "@/components/layout/TitleBar";
import { Toolbar } from "@/components/layout/Toolbar";
import { LeftRail } from "@/components/layout/LeftRail";
import { StatusStrip } from "@/components/layout/StatusStrip";
import { WelcomeScreen } from "@/components/views/WelcomeScreen";
import { CommandPalette } from "@/components/common/CommandPalette";
import { DiffPane } from "@/components/agents/DiffPane";
import { SideChatOverlay } from "@/components/agents/SideChatOverlay";
import { LoginPtyModal } from "@/components/auth/LoginPtyModal";
import { useSideChatHotkey } from "@/hooks/useSideChatHotkey";
import { useDictationTarget } from "@/hooks/useDictationTarget";
import { useDictationGlobalShortcuts } from "@/hooks/useDictationGlobalShortcuts";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMosaicStore } from "@/stores/mosaicStore";
import { useAppStore, getModuleId } from "@/stores/appStore";
import { useModuleStore } from "@/stores/moduleStore";
import { useDictationStore } from "@/stores/dictationStore";
import { useProjectHistoryStore } from "@/stores/projectHistoryStore";
import { getModule } from "@/modules/registry";
import { useStatusLinePoller, useCodexStatusLinePoller, useGeminiStatusLinePoller, useOpenCodeStatusLinePoller } from "@/hooks/useStatusLine";
import { initializeApp, persistUiState } from "@/lib/bootstrap";
import { requestNotificationPermission } from "@/lib/notifications";
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
const FlightsView = lazy(() => import("@/components/views/FlightsView").then((m) => ({ default: m.FlightsView })));

const AgentsView = lazy(() => import("@/components/views/AgentsView").then((m) => ({ default: m.AgentsView })));
const CostDashboardView = lazy(() => import("@/components/views/CostDashboardView").then((m) => ({ default: m.CostDashboardView })));
const DictationView = lazy(() => import("@/components/views/DictationView").then((m) => ({ default: m.DictationView })));

function ViewLoader() {
  return (
    <div className="flex flex-1 items-center justify-center text-xs text-text-secondary">
      Loading…
    </div>
  );
}

export default function App() {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const theme = useAppStore((s) => s.theme);
  // Poll status line data for all agents
  useStatusLinePoller();
  // Cmd/Ctrl+; opens the side chat overlay
  useSideChatHotkey();
  // Tracks the last-focused text input and inserts dictated transcripts at its cursor
  useDictationTarget();
  // OS-level global hotkeys so dictation works even when PacketADE is not focused
  useDictationGlobalShortcuts();
  useCodexStatusLinePoller();
  useGeminiStatusLinePoller();
  useOpenCodeStatusLinePoller();

  // Bootstrap: load backend state and hydrate all stores on first mount
  useEffect(() => {
    initializeApp();
    // Request OS notification permission early so async-agent completion
    // notifications can fire later. User-denial is the common case — swallow
    // silently; downstream `notify()` calls degrade gracefully.
    void requestNotificationPermission().catch(() => {});
  }, []);

  // Apply theme class to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Persist project path to localStorage and record in history
  const projectPath = useLayoutStore((s) => s.projectPath);
  useEffect(() => {
    if (!projectPath) return;
    localStorage.setItem("packetade:project-path", projectPath);
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


  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);

  // Tracks whether Ctrl+Shift+V is currently held for push-to-talk recording.
  // Set on keydown of V, cleared on keyup of V/Ctrl/Shift.
  const pushToTalkActiveRef = useRef(false);

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
      // Escape to cancel an active dictation recording (when palette is closed)
      if (e.key === "Escape") {
        const ds = useDictationStore.getState();
        if (ds.isRecording) {
          e.preventDefault();
          pushToTalkActiveRef.current = false;
          void ds.stopRecording().then(() => useDictationStore.getState().clearResult());
          return;
        }
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
        // Ctrl+Shift+D → Dictation view
        if (e.key === "D") {
          e.preventDefault();
          setActiveView("dictation");
          return;
        }
        // Ctrl+Shift+R → Toggle recording (start/stop)
        if (e.key === "R") {
          e.preventDefault();
          const ds = useDictationStore.getState();
          if (ds.isRecording) {
            void ds.stopRecording();
          } else {
            void ds.startRecording();
          }
          return;
        }
        // Ctrl+Shift+V → Push-to-talk: start on first keydown, stop on keyup (see keyup handler)
        if (e.key === "V") {
          e.preventDefault();
          if (e.repeat) return;
          const ds = useDictationStore.getState();
          if (!ds.isRecording && !pushToTalkActiveRef.current) {
            pushToTalkActiveRef.current = true;
            void ds.startRecording();
          }
          return;
        }
        const viewMap: Record<string, AppView> = {
          "!": "agents",    // Shift+1 — was "claude", remapped after CoreView retirement
          "@": "flights",  // Shift+2 — was "codex"
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
    [setActiveView]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Push-to-talk release: stop recording when V (or any modifier) is released
  // while pushToTalkActiveRef is set. Uses store snapshot to avoid stale closures.
  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      if (!pushToTalkActiveRef.current) return;
      const k = e.key;
      if (k === "V" || k === "v" || k === "Control" || k === "Shift") {
        pushToTalkActiveRef.current = false;
        const ds = useDictationStore.getState();
        if (ds.isRecording) {
          void ds.stopRecording();
        }
      }
    };
    window.addEventListener("keyup", handleKeyUp);
    return () => window.removeEventListener("keyup", handleKeyUp);
  }, []);

  // Global listeners for agent-login requests dispatched from the Agents pane.
  // AgentInputArea dispatches `packetade:open-claude-login` /
  // `packetade:open-codex-login` when the user clicks "Log in" on an
  // auth-required agent row. The login PTY is one-shot and rendered into
  // a floating modal via `useTransientPty` — no legacy mosaic pane is
  // created.
  const [loginCli, setLoginCli] = useState<"claude" | "codex" | null>(null);
  const [loginProjectPath, setLoginProjectPath] = useState<string | undefined>(undefined);
  useEffect(() => {
    const openLogin = (cli: "claude" | "codex") => {
      const layoutStore = useLayoutStore.getState();
      setLoginProjectPath(layoutStore.projectPath || undefined);
      setLoginCli(cli);
    };
    const handleClaudeLogin = () => openLogin("claude");
    const handleCodexLogin = () => openLogin("codex");
    window.addEventListener("packetade:open-claude-login", handleClaudeLogin);
    window.addEventListener("packetade:open-codex-login", handleCodexLogin);
    return () => {
      window.removeEventListener("packetade:open-claude-login", handleClaudeLogin);
      window.removeEventListener("packetade:open-codex-login", handleCodexLogin);
    };
  }, []);

  const showWorkspaceSidebar = activeView === "workspace";

  return (
    <ErrorBoundary fallbackMessage="PacketADE encountered an error">
      <div className="flex flex-col h-screen bg-bg-primary text-text-primary font-sans">
        <TitleBar />
        <Toolbar />
        <div className="flex flex-1 overflow-hidden">
          {/* Primary view nav */}
          <LeftRail />
          {/* Main content area */}
          <div className="flex flex-col flex-1 overflow-hidden">
            <ErrorBoundary fallbackMessage="View error">
              {/* Welcome screen */}
              {activeView === "welcome" && (
                <div className="flex flex-col flex-1 overflow-hidden">
                  <WelcomeScreen />
                </div>
              )}
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
        <StatusStrip />
        {commandPaletteOpen && <CommandPalette />}
        <DiffPane />
        <SideChatOverlay />
        {loginCli && (
          <LoginPtyModal
            cli={loginCli}
            projectPath={loginProjectPath}
            onClose={() => setLoginCli(null)}
          />
        )}
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
    case "flights":
      return <FlightsView />;
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
    case "agents":
      return <AgentsView />;
    case "cost_dashboard":
      return <CostDashboardView />;
    case "dictation":
      return <DictationView />;
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
