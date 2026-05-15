import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { LayoutGrid, Check, FileText, ShieldOff, Loader2, FolderOpen, ChevronDown, Zap, Server, AlertTriangle, CheckCircle2, XCircle, GitBranch } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useAgentStore } from "@/stores/agentStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useServerStore } from "@/stores/serverStore";
// Memory context is now injected live at session launch, not baked into workspace prompt
import { usePromptStore } from "@/stores/promptStore";
import { useAppStore } from "@/stores/appStore";
import { computeGridLayout } from "@/lib/gridLayout";
import { INSTALL_HINTS } from "@/lib/agent-install-hints";
import { CLAUDE_MODELS, CODEX_MODELS, GEMINI_MODELS, OPENCODE_MODELS, PACKETCODE_MODELS, EFFORT_LEVELS, type EffortLevel } from "@/lib/models";
import { sshCheckRemotePath, gitGetOriginUrl, type RemotePathCheck } from "@/lib/tauri";
import { parseGithubRemote } from "@/lib/git";
import type { WorkspaceAgentSlot } from "@/types/workspace";

type LocationMode = "local" | "remote";

type PathProbeState =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "ok"; result: RemotePathCheck }
  | { kind: "error"; message: string };

type AgentChoice = "claude-code" | "codex" | "gemini" | "opencode" | "packetcode";

/** Agents that support the --effort flag */
const EFFORT_SUPPORTED = new Set<string>(["claude-code"]);

const AGENT_SLOTS: { id: WorkspaceAgentSlot; cliId: AgentChoice | null; label: string; cliCommand: string }[] = [
  { id: "terminal", cliId: null, label: "Terminal", cliCommand: "bash" },
  { id: "claude-code", cliId: "claude-code", label: "Claude Code", cliCommand: "claude" },
  { id: "codex", cliId: "codex", label: "Codex CLI", cliCommand: "codex" },
  { id: "gemini", cliId: "gemini", label: "Gemini CLI", cliCommand: "gemini" },
  { id: "opencode", cliId: "opencode", label: "OpenCode", cliCommand: "opencode" },
  { id: "packetcode", cliId: "packetcode", label: "PacketCode", cliCommand: "packetcode" },
];

const WORKSPACE_TEMPLATES = [
  { id: "solo", label: "Solo", description: "One AI agent", agents: ["claude-code"] as WorkspaceAgentSlot[] },
  { id: "duo", label: "Duo", description: "Two AI agents side-by-side", agents: ["claude-code", "codex"] as WorkspaceAgentSlot[] },
  { id: "review-trio", label: "Review Trio", description: "Builder + reviewer + terminal", agents: ["claude-code", "codex", "terminal"] as WorkspaceAgentSlot[] },
  { id: "research", label: "Research", description: "Claude + Gemini for research", agents: ["claude-code", "gemini"] as WorkspaceAgentSlot[] },
  { id: "full-stack", label: "Full Stack", description: "All available agents", agents: ["claude-code", "codex", "gemini", "terminal"] as WorkspaceAgentSlot[] },
];

const CLI_MODEL_MAP: Record<AgentChoice, typeof CLAUDE_MODELS> = {
  "claude-code": CLAUDE_MODELS,
  codex: CODEX_MODELS,
  gemini: GEMINI_MODELS,
  opencode: OPENCODE_MODELS,
  packetcode: PACKETCODE_MODELS,
};

interface WorkspaceCreationModalProps {
  onClose: () => void;
  initialSelected?: Set<WorkspaceAgentSlot>;
  serverId?: string;
  remoteProjectPath?: string;
}

export function WorkspaceCreationModal({ onClose, initialSelected, serverId: initialServerId, remoteProjectPath: initialRemoteProjectPath }: WorkspaceCreationModalProps) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<WorkspaceAgentSlot>>(() => initialSelected ?? new Set());
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [modelOverrides, setModelOverrides] = useState<Record<string, string | null>>({});
  const [effortOverrides, setEffortOverrides] = useState<Record<string, EffortLevel | null>>({ "claude-code": "medium" });
  // v0.8: seed from the user's "default bypass for new workspaces" setting.
  // Read once at mount via the store snapshot so toggling the setting later
  // doesn't yank the checkbox out from under the user mid-edit.
  const [bypassPermissions, setBypassPermissions] = useState(
    () => useWorkspaceStore.getState().defaultBypassPermissions,
  );
  const [prompt, setPrompt] = useState("");
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);

  // Location: Local vs Remote. Pre-selects "remote" when the caller passes
  // a serverId (e.g. the Servers view's "New workspace on this server"
  // button). Otherwise defaults to Local.
  const [locationMode, setLocationMode] = useState<LocationMode>(initialServerId ? "remote" : "local");
  const [serverId, setServerId] = useState<string | undefined>(initialServerId);
  const [remoteProjectPath, setRemoteProjectPath] = useState<string>(initialRemoteProjectPath ?? "");
  const [serverDropdownOpen, setServerDropdownOpen] = useState(false);
  const serverDropdownRef = useRef<HTMLDivElement>(null);
  const [pathProbe, setPathProbe] = useState<PathProbeState>({ kind: "idle" });

  // Local project path (only used when locationMode === "local").
  const [selectedProjectPath, setSelectedProjectPath] = useState(projectPath);

  // v0.8-15: auto-bind to GitHub repo via `git remote get-url origin`.
  // Probe runs against the local project path whenever it changes. We
  // stamp the parsed `{owner, repo}` onto the workspace at save time so
  // the GitHub pane (and the WorkspaceSidebar badge) can render
  // repo-aware affordances without the user picking a repo manually.
  // Remote workspaces are skipped — the git binary lives on the host
  // and we'd need an SSH round-trip we haven't wired here yet.
  const [detectedGithubRepo, setDetectedGithubRepo] = useState<{ owner: string; repo: string } | null>(null);

  const agents = useAgentStore((s) => s.agents);
  const detecting = useAgentStore((s) => s.detecting);
  const servers = useServerStore((s) => s.servers);
  const server = useMemo(
    () => (serverId ? servers.find((srv) => srv.id === serverId) : undefined),
    [serverId, servers],
  );
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const setActiveView = useAppStore((s) => s.setActiveView);

  // If the user picks a server and the path field is empty, seed it from
  // the server's default remotePath (matches the legacy
  // `initialRemoteProjectPath ?? server.remotePath` behaviour).
  useEffect(() => {
    if (locationMode !== "remote" || !server) return;
    setRemoteProjectPath((prev) => (prev.trim() ? prev : server.remotePath ?? ""));
  }, [locationMode, server]);

  const installedAgentIds = useMemo(() => {
    if (locationMode === "remote") {
      return new Set(server?.installedAgents ?? []);
    }
    return new Set(agents.filter((agent) => agent.installed).map((agent) => agent.id));
  }, [agents, server?.installedAgents, locationMode]);

  const isAgentInstalled = useCallback((id: WorkspaceAgentSlot) => {
    return id === "terminal" || installedAgentIds.has(id);
  }, [installedAgentIds]);

  // Unique project paths from existing workspaces + current global path
  const recentProjectPaths = useMemo(() => {
    if (locationMode === "remote") {
      return remoteProjectPath ? [remoteProjectPath] : [];
    }
    const paths = new Set<string>([projectPath]);
    for (const w of useWorkspaceStore.getState().workspaces) {
      if (w.projectPath && !w.serverId) paths.add(w.projectPath);
    }
    return Array.from(paths);
  }, [remoteProjectPath, projectPath, locationMode]);

  useEffect(() => {
    setSelected((prev) => {
      const available = Array.from(prev).filter((agent) => isAgentInstalled(agent));
      if (available.length === prev.size) return prev;
      return new Set(available);
    });
  }, [isAgentInstalled]);

  // Close project dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) {
        setProjectDropdownOpen(false);
      }
      if (serverDropdownRef.current && !serverDropdownRef.current.contains(e.target as Node)) {
        setServerDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Live-validate the remote path. Debounced so each keystroke does not
  // dispatch an SSH command. Skipped entirely when the server lacks a
  // pinned host fingerprint — running an SSH probe to an unverified host
  // would defeat the whole point of host-key pinning.
  useEffect(() => {
    if (locationMode !== "remote") {
      setPathProbe({ kind: "idle" });
      return;
    }
    if (!server) {
      setPathProbe({ kind: "idle" });
      return;
    }
    if (!server.hostFingerprint) {
      // Skip the probe — the user must verify the host key on the
      // Servers page first. The fingerprint banner takes over from here.
      setPathProbe({ kind: "idle" });
      return;
    }
    const trimmed = remoteProjectPath.trim();
    if (!trimmed) {
      setPathProbe({ kind: "idle" });
      return;
    }

    let cancelled = false;
    setPathProbe({ kind: "probing" });

    const handle = window.setTimeout(() => {
      sshCheckRemotePath({
        host: server.host,
        port: server.port,
        user: server.username,
        authMethod: server.authMethod,
        keyPath: server.keyPath,
        hostFingerprint: server.hostFingerprint,
        remotePath: trimmed,
      })
        .then((result) => {
          if (cancelled) return;
          setPathProbe({ kind: "ok", result });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          setPathProbe({ kind: "error", message });
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [locationMode, server, remoteProjectPath]);

  // v0.8-15: probe `git remote get-url origin` whenever the local
  // project path changes. Failures (non-git dir, no `origin`) are
  // silent — auto-bind is a best-effort polish, never blocking.
  //
  // v0.8 setting: gated on `useWorkspaceStore.autoBindGithubRepo`. When the
  // user has disabled the auto-bind, we skip the probe entirely so we
  // never run `git remote get-url origin` against their local path. They
  // can still bind manually later from the GitHub pane.
  useEffect(() => {
    if (locationMode !== "local") {
      setDetectedGithubRepo(null);
      return;
    }
    if (!useWorkspaceStore.getState().autoBindGithubRepo) {
      setDetectedGithubRepo(null);
      return;
    }
    const path = selectedProjectPath?.trim();
    if (!path) {
      setDetectedGithubRepo(null);
      return;
    }
    let cancelled = false;
    gitGetOriginUrl(path)
      .then((url) => {
        if (cancelled) return;
        if (!url) {
          setDetectedGithubRepo(null);
          return;
        }
        setDetectedGithubRepo(parseGithubRemote(url));
      })
      .catch(() => {
        if (cancelled) return;
        setDetectedGithubRepo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [locationMode, selectedProjectPath]);

  const preview = useMemo(() => {
    if (selected.size === 0) return null;
    return computeGridLayout(selected.size);
  }, [selected.size]);

  // Get the AI agents that are selected (not terminal)
  const selectedAiAgents = AGENT_SLOTS.filter((s) => selected.has(s.id) && s.cliId);

  function applyTemplate(template: typeof WORKSPACE_TEMPLATES[number]) {
    const availableAgents = template.agents.filter((agent) => isAgentInstalled(agent));
    if (availableAgents.length === 0) return;
    setSelectedTemplateId(template.id);
    setSelected(new Set(availableAgents));
    if (!name.trim()) {
      setName(template.label);
    }
  }

  function toggleAgent(id: WorkspaceAgentSlot) {
    if (!isAgentInstalled(id)) return;
    setSelectedTemplateId(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setModelForAgent(agentId: string, model: string | null) {
    setModelOverrides((prev) => ({ ...prev, [agentId]: model }));
  }

  // Save is only enabled when the form is in a valid state. Memoised so we
  // can both gate the button and short-circuit handleCreate.
  const saveBlockedReason = useMemo<string | null>(() => {
    if (!name.trim()) return "Workspace name is required";
    if (selected.size === 0) return "Select at least one agent";
    if (locationMode === "remote") {
      if (!serverId || !server) return "Choose a server";
      if (!server.hostFingerprint) return "Verify the server's host key on the Servers page before connecting";
      if (!remoteProjectPath.trim()) return "Remote project path is required";
      if (pathProbe.kind === "probing") return "Verifying remote path…";
      if (pathProbe.kind === "ok" && pathProbe.result.exists && !pathProbe.result.isDirectory) {
        return "Remote path exists but is a file, not a directory";
      }
      if (pathProbe.kind === "error") return pathProbe.message;
    }
    return null;
  }, [name, selected.size, locationMode, serverId, server, remoteProjectPath, pathProbe]);

  function handleCreate() {
    if (saveBlockedReason) return;

    const orderedAgents = AGENT_SLOTS
      .filter((s) => selected.has(s.id) && isAgentInstalled(s.id))
      .map((s) => s.id);

    if (orderedAgents.length === 0) return;

    const finalPrompt = prompt.trim();

    // For remote workspaces, the "root path" we store is the remote path
    // (workspaceStore will use it as `projectPath`). For local workspaces
    // we keep using the user-selected local directory.
    const effectivePath = locationMode === "remote" ? remoteProjectPath.trim() : selectedProjectPath;

    createWorkspace(name.trim(), orderedAgents, effectivePath, {
      prompt: finalPrompt || undefined,
      modelOverrides,
      effortOverrides,
      bypassPermissions,
      serverId: locationMode === "remote" ? serverId : undefined,
      remoteProjectPath: locationMode === "remote" ? remoteProjectPath.trim() : undefined,
      // v0.8-15: stamp the auto-detected GitHub repo onto the workspace
      // so downstream surfaces (sidebar badge, GitHub pane) can render
      // the binding without re-probing.
      githubRepo: locationMode === "local" ? detectedGithubRepo ?? undefined : undefined,
    });

    useAppStore.getState().setActiveView("workspace");
    onClose();
  }

  function handleOpenServersView() {
    setActiveView("tools");
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      handleCreate();
    }
  }

  return (
    <Modal
      onClose={onClose}
      title="New Workspace"
      icon={<LayoutGrid size={16} className="text-accent-green" />}
      width="w-[480px]"
      footer={
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={saveBlockedReason !== null}
            title={saveBlockedReason ?? undefined}
            className="px-4 py-1.5 text-xs bg-accent-green/15 text-accent-green border border-accent-green/30 rounded font-medium hover:bg-accent-green/25 transition-colors disabled:opacity-40"
          >
            Create Workspace
          </button>
        </div>
      }
    >
      <div className="px-5 py-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto" onKeyDown={handleKeyDown}>
        {/* Location: Local vs Remote (SSH) */}
        <div>
          <label className="text-[10px] text-text-muted block mb-1 uppercase tracking-wider">Location</label>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setLocationMode("local")}
              className={`flex items-center gap-2 px-3 py-2 text-[11px] rounded border transition-colors ${
                locationMode === "local"
                  ? "bg-accent-green/15 border-accent-green/40 text-accent-green font-medium"
                  : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
              }`}
            >
              <FolderOpen size={12} />
              <span className="flex flex-col items-start">
                <span>Local</span>
                <span className="text-[10px] text-text-muted">This machine</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setLocationMode("remote")}
              className={`flex items-center gap-2 px-3 py-2 text-[11px] rounded border transition-colors ${
                locationMode === "remote"
                  ? "bg-accent-blue/15 border-accent-blue/40 text-accent-blue font-medium"
                  : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
              }`}
            >
              <Server size={12} />
              <span className="flex flex-col items-start">
                <span>Remote (SSH)</span>
                <span className="text-[10px] text-text-muted">Saved server</span>
              </span>
            </button>
          </div>
        </div>

        {/* Local: Project Path */}
        {locationMode === "local" && (
          <div ref={projectDropdownRef}>
            <label className="text-[10px] text-text-muted block mb-1 uppercase tracking-wider">Project</label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
                className="flex items-center gap-2 w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs text-left hover:border-text-muted/30 transition-colors"
              >
                <FolderOpen size={12} className="text-accent-green flex-shrink-0" />
                <span className="flex-1 truncate text-text-primary" title={selectedProjectPath}>
                  {selectedProjectPath.split(/[\\/]/).pop()}
                </span>
                <span className="text-[10px] text-text-muted truncate max-w-[200px]" title={selectedProjectPath}>
                  {selectedProjectPath}
                </span>
                <ChevronDown
                  size={10}
                  className={`text-text-muted flex-shrink-0 transition-transform ${projectDropdownOpen ? "rotate-180" : ""}`}
                />
              </button>
              {projectDropdownOpen && recentProjectPaths.length > 1 && (
                <div className="absolute top-full left-0 mt-1 w-full bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1 max-h-[160px] overflow-y-auto">
                  {recentProjectPaths.map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setSelectedProjectPath(p);
                        setProjectDropdownOpen(false);
                      }}
                      className={`flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-bg-hover transition-colors ${
                        p === selectedProjectPath ? "bg-accent-green/10" : ""
                      }`}
                    >
                      <FolderOpen size={11} className={p === selectedProjectPath ? "text-accent-green" : "text-text-muted"} />
                      <span className="flex-1 truncate text-[11px] text-text-primary">{p.split(/[\\/]/).pop()}</span>
                      <span className="text-[10px] text-text-muted truncate max-w-[180px]">{p}</span>
                      {p === selectedProjectPath && <Check size={10} className="text-accent-green flex-shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Remote: Server picker + remote project path */}
        {locationMode === "remote" && (
          <div className="flex flex-col gap-3">
            {servers.length === 0 ? (
              <div className="rounded border border-bg-border bg-bg-primary px-3 py-3 text-[11px] text-text-secondary">
                <div className="flex items-center gap-2 mb-1.5">
                  <Server size={12} className="text-text-muted" />
                  <span className="font-medium text-text-primary">No servers configured</span>
                </div>
                <p className="text-text-muted text-[10px] mb-2">
                  Add a server in the Tools view to use it as a remote workspace target.
                </p>
                <button
                  type="button"
                  onClick={handleOpenServersView}
                  className="text-[11px] text-accent-blue hover:underline"
                >
                  Open Servers settings →
                </button>
              </div>
            ) : (
              <div ref={serverDropdownRef}>
                <label className="text-[10px] text-text-muted block mb-1 uppercase tracking-wider">Server</label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setServerDropdownOpen(!serverDropdownOpen)}
                    className="flex items-center gap-2 w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs text-left hover:border-text-muted/30 transition-colors"
                  >
                    <Server size={12} className="text-accent-blue flex-shrink-0" />
                    {server ? (
                      <>
                        <span className="flex-1 truncate text-text-primary" title={server.name}>
                          {server.name}
                        </span>
                        <span className="text-[10px] text-text-muted truncate max-w-[200px]" title={`${server.username}@${server.host}:${server.port}`}>
                          {server.username}@{server.host}:{server.port}
                        </span>
                      </>
                    ) : (
                      <span className="flex-1 text-text-muted italic">Choose a server…</span>
                    )}
                    <ChevronDown
                      size={10}
                      className={`text-text-muted flex-shrink-0 transition-transform ${serverDropdownOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  {serverDropdownOpen && (
                    <div className="absolute top-full left-0 mt-1 w-full bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1 max-h-[200px] overflow-y-auto">
                      {servers.map((srv) => (
                        <button
                          key={srv.id}
                          onClick={() => {
                            setServerId(srv.id);
                            // Reset path probe + seed path field from
                            // the new server's default remotePath if the
                            // user hasn't typed anything.
                            setRemoteProjectPath((prev) => (prev.trim() ? prev : srv.remotePath ?? ""));
                            setServerDropdownOpen(false);
                          }}
                          className={`flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-bg-hover transition-colors ${
                            srv.id === serverId ? "bg-accent-blue/10" : ""
                          }`}
                        >
                          <Server size={11} className={srv.id === serverId ? "text-accent-blue" : "text-text-muted"} />
                          <span className="flex-1 truncate text-[11px] text-text-primary">{srv.name}</span>
                          <span className="text-[10px] text-text-muted truncate max-w-[180px]">
                            {srv.username}@{srv.host}:{srv.port}
                          </span>
                          {srv.id === serverId && <Check size={10} className="text-accent-blue flex-shrink-0" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Host-key warning */}
            {server && !server.hostFingerprint && (
              <div className="rounded border border-accent-amber/30 bg-accent-amber/5 px-3 py-2 text-[11px] text-accent-amber flex items-start gap-2">
                <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-medium">Host key not verified.</div>
                  <p className="text-text-secondary mt-1">
                    Verify the host key on the Servers page before connecting. We won't probe an unpinned host.
                  </p>
                  <button
                    type="button"
                    onClick={handleOpenServersView}
                    className="mt-1 text-[11px] underline hover:text-accent-amber"
                  >
                    Open Servers settings →
                  </button>
                </div>
              </div>
            )}

            {/* Remote project path input */}
            {server && server.hostFingerprint && (
              <div>
                <label className="text-[10px] text-text-muted block mb-1 uppercase tracking-wider">
                  Remote Project Path
                </label>
                <input
                  type="text"
                  value={remoteProjectPath}
                  onChange={(e) => setRemoteProjectPath(e.target.value)}
                  placeholder={server.remotePath || "/srv/projects/my-app"}
                  className="w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue"
                />
                <RemotePathProbeIndicator state={pathProbe} />
              </div>
            )}
          </div>
        )}

        {/* Name */}
        <div>
          <label className="text-[10px] text-text-muted block mb-1 uppercase tracking-wider">Workspace Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Workspace"
            className="w-full bg-bg-primary border border-bg-border rounded px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
            autoFocus
          />
        </div>

        {/* Workspace Templates */}
        <div>
          <label className="text-[10px] text-text-muted block mb-2 uppercase tracking-wider">
            <Zap size={10} className="inline mr-1 -mt-px" />
            Templates
          </label>
          <div className="flex flex-wrap gap-1.5">
            {WORKSPACE_TEMPLATES.map((tpl) => {
              const isActive = selectedTemplateId === tpl.id;
              const agentLabels = tpl.agents.map((a) => AGENT_SLOTS.find((s) => s.id === a)?.label ?? a);
              const availableAgents = tpl.agents.filter((agent) => isAgentInstalled(agent));
              const disabled = availableAgents.length === 0;
              const unavailableLabels = tpl.agents
                .filter((agent) => !isAgentInstalled(agent))
                .map((agent) => AGENT_SLOTS.find((s) => s.id === agent)?.label ?? agent);
              return (
                <button
                  key={tpl.id}
                  onClick={() => applyTemplate(tpl)}
                  disabled={disabled}
                  title={unavailableLabels.length > 0 ? `Unavailable: ${unavailableLabels.join(", ")}` : tpl.description}
                  className={`flex flex-col items-start px-3 py-2 text-[11px] rounded border transition-colors ${
                    isActive
                      ? "bg-accent-green/15 border-accent-green/40"
                      : "bg-bg-primary border-bg-border hover:border-text-muted/30"
                  } ${disabled ? "opacity-50 cursor-not-allowed hover:border-bg-border" : ""}`}
                >
                  <span className={`font-medium ${isActive ? "text-accent-green" : "text-text-primary"}`}>
                    {tpl.label}
                  </span>
                  <span className="text-[10px] text-text-muted mt-0.5">{tpl.description}</span>
                  <span className="text-[10px] text-text-muted mt-1 opacity-70">
                    {agentLabels.join(" + ")}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Agent Selection — multi-toggle buttons */}
        <div>
          <label className="text-[10px] text-text-muted block mb-2 uppercase tracking-wider">Agents</label>
          {detecting && (
            <p className="flex items-center gap-1 text-[10px] text-text-muted italic mb-2">
              <Loader2 size={10} className="animate-spin" />
              Checking CLI availability…
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {AGENT_SLOTS.map((slot) => {
              const installed = isAgentInstalled(slot.id);
              const isSelected = selected.has(slot.id);
              const hint = INSTALL_HINTS[slot.id];

              return (
                <div key={slot.id} className="flex items-center gap-1">
                  <button
                    onClick={() => toggleAgent(slot.id)}
                    disabled={!installed}
                    title={installed ? slot.label : `${slot.label} not found — click the install link to set it up`}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded border transition-colors ${
                      isSelected
                        ? "bg-accent-green/15 border-accent-green/40 text-accent-green font-medium"
                        : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                    } ${!installed ? "opacity-50 cursor-not-allowed hover:text-text-muted hover:border-bg-border" : ""}`}
                  >
                    <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${
                      isSelected ? "bg-accent-green border-accent-green" : "border-bg-border"
                    }`}>
                      {isSelected && <Check size={8} className="text-bg-primary" />}
                    </div>
                    {slot.label}
                  </button>
                  {!installed && hint && !detecting && (
                    <a
                      href={hint.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] text-accent-amber underline opacity-80 hover:opacity-100"
                      title={hint.label}
                    >
                      install
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Bypass permissions toggle */}
        {selectedAiAgents.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={bypassPermissions}
                onChange={(e) => setBypassPermissions(e.target.checked)}
                className="w-3 h-3 rounded border-bg-border accent-accent-amber"
              />
              <ShieldOff size={11} className={bypassPermissions ? "text-accent-amber" : "text-text-muted"} />
              <span className={`text-[11px] ${bypassPermissions ? "text-accent-amber" : "text-text-secondary"}`}>
                Bypass permissions
              </span>
            </label>
            {bypassPermissions && selected.has("opencode") && (
              <span className="text-[10px] text-text-muted ml-5">
                Not applied to OpenCode — no equivalent CLI flag in current release. Approve tools in the TUI or set rules in opencode.json.
              </span>
            )}
          </div>
        )}

        {/* Model selection per selected AI agent */}
        {selectedAiAgents.map((slot) => {
          const models = CLI_MODEL_MAP[slot.cliId!];

          // OpenCode manages its own models internally
          if (models.length === 0) {
            return (
              <div key={slot.id} className="opacity-50">
                <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
                  {slot.label} Model
                </label>
                <span className="text-[11px] text-text-muted italic">Configured inside {slot.label}</span>
              </div>
            );
          }

          const currentModel = modelOverrides[slot.id] ?? null;
          return (
            <div key={slot.id}>
              <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
                {slot.label} Model
              </label>
              <div className="flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <button
                    key={m.label}
                    onClick={() => setModelForAgent(slot.id, m.value)}
                    className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${
                      currentModel === m.value
                        ? "bg-accent-amber/15 border-accent-amber/40 text-accent-amber font-medium"
                        : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        {/* Effort level per selected AI agent */}
        {selectedAiAgents.map((slot) => {
          if (!EFFORT_SUPPORTED.has(slot.id)) {
            return null;
          }
          const currentEffort = effortOverrides[slot.id] ?? null;
          return (
            <div key={`effort-${slot.id}`}>
              <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
                {slot.label} Effort
              </label>
              <div className="flex flex-wrap gap-1.5">
                {EFFORT_LEVELS.map((e) => (
                  <button
                    key={e.value}
                    onClick={() => setEffortOverrides((prev) => ({ ...prev, [slot.id]: e.value }))}
                    className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${
                      currentEffort === e.value
                        ? "bg-accent-purple/15 border-accent-purple/40 text-accent-purple font-medium"
                        : "bg-bg-primary border-bg-border text-text-muted hover:text-text-secondary hover:border-text-muted/30"
                    }`}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        {/* Prompt Template Picker */}
        {selectedAiAgents.length > 0 && (
          <TemplatePicker onSelect={(content) => setPrompt(content)} />
        )}

        {/* Prompt */}
        {selectedAiAgents.length > 0 && (
          <div>
            <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
              Initial Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="Describe the task for all agents..."
              className="w-full bg-bg-primary border border-bg-border rounded px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-amber resize-none"
            />
            <p className="text-[10px] text-text-muted mt-1">
              Ctrl+Enter to create
            </p>
          </div>
        )}

        {/* Grid Preview */}
        {preview && (
          <div>
            <label className="text-[10px] text-text-muted block mb-2 uppercase tracking-wider">Layout Preview</label>
            <div
              className="gap-1 max-w-[200px]"
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${preview.cols}, 1fr)`,
                gridTemplateRows: `repeat(${preview.rows}, 1fr)`,
              }}
            >
              {preview.cells.map((cell) => {
                const selectedArr = AGENT_SLOTS.filter((s) => selected.has(s.id));
                const agent = cell.agentIndex !== null ? selectedArr[cell.agentIndex] : null;
                return (
                  <div
                    key={`${cell.row}-${cell.col}`}
                    className={`h-10 rounded flex items-center justify-center text-[9px] ${
                      agent
                        ? "bg-accent-green/10 text-accent-green border border-accent-green/20"
                        : "border border-dashed border-bg-border text-text-muted"
                    }`}
                  >
                    {agent?.label ?? ""}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Small inline status row underneath the Remote Project Path input.
 *  Reflects the debounced `sshCheckRemotePath` probe state. Never returns
 *  null — empty/idle renders a placeholder so the modal height stays
 *  stable while the user types. */
function RemotePathProbeIndicator({ state }: { state: PathProbeState }) {
  if (state.kind === "idle") {
    return (
      <p className="text-[10px] text-text-muted mt-1">
        Type a path to verify it exists on the host.
      </p>
    );
  }
  if (state.kind === "probing") {
    return (
      <p className="flex items-center gap-1 text-[10px] text-text-muted mt-1">
        <Loader2 size={10} className="animate-spin" />
        Checking remote path…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="flex items-center gap-1 text-[10px] text-accent-red mt-1">
        <XCircle size={10} />
        {state.message}
      </p>
    );
  }
  // ok
  const { exists, isDirectory, isGitRepo } = state.result;
  if (!exists) {
    return (
      <p className="flex items-center gap-1 text-[10px] text-accent-amber mt-1">
        <AlertTriangle size={10} />
        Path does not exist — it will be created when the workspace starts.
      </p>
    );
  }
  if (!isDirectory) {
    return (
      <p className="flex items-center gap-1 text-[10px] text-accent-red mt-1">
        <XCircle size={10} />
        Path is a file, not a directory.
      </p>
    );
  }
  if (isGitRepo) {
    return (
      <p className="flex items-center gap-1 text-[10px] text-accent-green mt-1">
        <GitBranch size={10} />
        Git repository detected.
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1 text-[10px] text-accent-green mt-1">
      <CheckCircle2 size={10} />
      Directory exists.
    </p>
  );
}

function TemplatePicker({ onSelect }: { onSelect: (content: string) => void }) {
  const templates = usePromptStore((s) => s.templates);
  const [open, setOpen] = useState(false);

  if (templates.length === 0) return null;

  return (
    <div>
      <label className="block text-[10px] text-text-muted mb-1.5 uppercase tracking-wider">
        Prompt Template
      </label>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] bg-bg-primary border border-bg-border rounded w-full text-left text-text-secondary hover:border-text-muted/30 transition-colors"
        >
          <FileText size={11} className="text-accent-amber flex-shrink-0" />
          <span className="flex-1 truncate">Select a template...</span>
        </button>
        {open && (
          <div className="absolute top-full left-0 mt-1 w-full bg-bg-secondary border border-bg-border rounded-lg shadow-xl z-50 py-1 max-h-[200px] overflow-y-auto">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  onSelect(t.content);
                  setOpen(false);
                }}
                className="flex flex-col w-full px-3 py-2 text-left hover:bg-bg-hover transition-colors"
              >
                <span className="text-[11px] text-text-primary">{t.name}</span>
                <span className="text-[10px] text-text-muted truncate">
                  {t.content.slice(0, 80)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
