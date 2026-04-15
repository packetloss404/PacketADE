import { useEffect, useState, useCallback, useRef } from "react";
import {
  Rocket,
  Plus,
  Play,
  Trash2,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  AlertTriangle,
  GitBranch,
  ChevronDown,
  ChevronRight,
  Terminal,
} from "lucide-react";
import { useDeployStore } from "@/stores/deployStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { DeployConfigModal } from "./DeployConfigModal";
import { DeployTerminal } from "./DeployTerminal";
import type { DeployConfig, DeployRun } from "@/types/deploy";

export function DeployView() {
  const {
    configs,
    configSource,
    loading,
    error,
    runs,
    activeRunId,
    lastValidation,
    validating,
    fetchConfigs,
    addConfig,
    removeConfig,
    startRun,
    finishRun,
    setActiveRunId,
    clearValidation,
  } = useDeployStore();
  const projectPath = useLayoutStore((s) => s.projectPath);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showOutput, setShowOutput] = useState<string | null>(null);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs, projectPath]);

  const activeRun = runs.find((r) => r.id === activeRunId);

  const handleDeploy = useCallback(
    async (config: DeployConfig) => {
      clearValidation();
      await startRun(config);
    },
    [startRun, clearValidation]
  );

  const handleExit = useCallback(
    (code: number) => {
      if (activeRunId) {
        finishRun(activeRunId, code === 0 ? "success" : "failed");
      }
    },
    [activeRunId, finishRun]
  );

  async function handleAddConfig(config: DeployConfig) {
    await addConfig(config);
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-bg-border bg-bg-secondary shrink-0">
        <div className="flex items-center gap-2">
          <Rocket size={14} className="text-accent-amber" />
          <h2 className="text-sm font-medium text-text-primary">Deploy</h2>
          {configSource !== "none" && (
            <span className="text-[10px] text-text-muted px-1.5 py-0.5 bg-bg-elevated rounded">
              {configSource}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchConfigs()}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
            title="Refresh configs"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={() => setShowConfigModal(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 transition-colors"
          >
            <Plus size={12} />
            Add Config
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400 shrink-0">
          {error}
        </div>
      )}

      {/* Validation banner */}
      {lastValidation && (lastValidation.warnings.length > 0 || !lastValidation.valid) && (
        <div className="mx-4 mt-3 shrink-0 space-y-1.5">
          {lastValidation.errors.map((err, i) => (
            <div
              key={`err-${i}`}
              className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400"
            >
              <XCircle size={12} className="shrink-0" />
              {err}
            </div>
          ))}
          {lastValidation.warnings.map((warn, i) => (
            <div
              key={`warn-${i}`}
              className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded text-xs text-amber-400"
            >
              <AlertTriangle size={12} className="shrink-0" />
              {warn}
            </div>
          ))}
          {lastValidation.valid && lastValidation.gitBranch && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] text-text-muted">
              <GitBranch size={10} />
              Deploying from <span className="text-accent-green font-medium">{lastValidation.gitBranch}</span>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left panel -- configs + history */}
        <div className="w-64 border-r border-bg-border flex flex-col shrink-0 overflow-y-auto">
          {/* Deploy configs */}
          <div className="p-3">
            <h3 className="text-[11px] font-medium text-text-secondary uppercase tracking-wider mb-2">
              Configurations
            </h3>
            {configs.length === 0 && !loading && (
              <p className="text-[11px] text-text-muted py-4 text-center">
                No deploy configs found
              </p>
            )}
            <div className="space-y-1.5">
              {configs.map((config) => (
                <div
                  key={config.name}
                  className="flex items-center gap-2 px-2.5 py-2 bg-bg-secondary border border-bg-border rounded-lg group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-text-primary truncate">
                      {config.name}
                    </div>
                    <div className="text-[10px] text-text-muted truncate mt-0.5">
                      {config.command}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleDeploy(config)}
                      disabled={validating || runs.some((r) => r.status === "running")}
                      className="p-1 text-accent-green hover:text-accent-green/80 transition-colors disabled:opacity-40"
                      title="Deploy"
                    >
                      {validating ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Play size={12} />
                      )}
                    </button>
                    <button
                      onClick={() => removeConfig(config.name)}
                      className="p-1 text-text-muted hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                      title="Remove"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Run history */}
          {runs.length > 0 && (
            <div className="p-3 border-t border-bg-border">
              <h3 className="text-[11px] font-medium text-text-secondary uppercase tracking-wider mb-2">
                History
              </h3>
              <div className="space-y-1">
                {runs.map((run) => (
                  <div key={run.id} className="space-y-0.5">
                    <button
                      onClick={() => setActiveRunId(run.id)}
                      className={`flex items-center gap-2 w-full px-2.5 py-1.5 rounded text-left transition-colors ${
                        activeRunId === run.id
                          ? "bg-bg-elevated text-text-primary"
                          : "text-text-secondary hover:bg-bg-hover"
                      }`}
                    >
                      <RunStatusIcon status={run.status} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] truncate">{run.configName}</div>
                        <div className="text-[9px] text-text-muted">
                          {formatTime(run.startedAt)}
                          {run.finishedAt && (
                            <span className="ml-1">
                              ({Math.round((run.finishedAt - run.startedAt) / 1000)}s)
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    {/* Collapsible output for completed runs */}
                    {run.output.length > 0 && run.status !== "running" && (
                      <button
                        onClick={() => setShowOutput(showOutput === run.id ? null : run.id)}
                        className="flex items-center gap-1 pl-7 text-[10px] text-text-muted hover:text-text-secondary transition-colors"
                      >
                        {showOutput === run.id ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                        <Terminal size={9} />
                        {run.output.length} output chunks
                      </button>
                    )}
                    {showOutput === run.id && (
                      <OutputPanel run={run} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right panel -- terminal output */}
        <div className="flex-1 flex flex-col min-h-0 p-3">
          {activeRun ? (
            <>
              <div className="flex items-center gap-2 mb-2 shrink-0">
                <RunStatusIcon status={activeRun.status} />
                <span className="text-xs font-medium text-text-primary">
                  {activeRun.configName}
                </span>
                <span className="text-[10px] text-text-muted">
                  {activeRun.command}
                </span>
                {activeRun.status === "running" && (
                  <span className="text-[10px] text-accent-amber ml-auto flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" />
                    Running...
                  </span>
                )}
                {activeRun.finishedAt && (
                  <span className="text-[10px] text-text-muted ml-auto">
                    {Math.round((activeRun.finishedAt - activeRun.startedAt) / 1000)}s
                  </span>
                )}
              </div>
              {activeRun.sessionId ? (
                <DeployTerminal
                  sessionId={activeRun.sessionId}
                  onExit={handleExit}
                />
              ) : (
                <RunOutputViewer run={activeRun} />
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-text-muted">
              <Rocket size={24} className="mb-3 opacity-30" />
              <p className="text-xs">Select a config and click Deploy to start</p>
              {configs.length === 0 && (
                <p className="text-[11px] mt-1">
                  Or add a <code className="text-accent-green">packetcode.deploy.json</code> to your project
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {showConfigModal && (
        <DeployConfigModal
          onClose={() => setShowConfigModal(false)}
          onSave={handleAddConfig}
        />
      )}
    </div>
  );
}

/** Compact inline output panel shown in the history sidebar */
function OutputPanel({ run }: { run: DeployRun }) {
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      className="ml-7 mr-1 mt-0.5 max-h-32 overflow-y-auto bg-[#0d1117] rounded border border-bg-border p-1.5"
    >
      <pre className="text-[9px] text-text-muted font-mono whitespace-pre-wrap break-all leading-tight">
        {run.output.join("")}
      </pre>
    </div>
  );
}

/** Full-size output viewer for runs that have no active terminal session */
function RunOutputViewer({ run }: { run: DeployRun }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(run.status === "running");

  useEffect(() => {
    if (run.status === "running" && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    wasRunning.current = run.status === "running";
  }, [run.output.length, run.status]);

  if (run.output.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-xs">
        {run.status === "running" ? (
          <span className="flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" />
            Waiting for output...
          </span>
        ) : (
          "No output captured"
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-y-auto bg-[#0d1117] rounded-lg p-3 font-mono"
    >
      <pre className="text-xs text-[#c9d1d9] whitespace-pre-wrap break-all leading-relaxed">
        {run.output.join("")}
      </pre>
    </div>
  );
}

function RunStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
      return <Loader2 size={12} className="text-accent-amber animate-spin" />;
    case "success":
      return <CheckCircle2 size={12} className="text-accent-green" />;
    case "failed":
      return <XCircle size={12} className="text-red-400" />;
    default:
      return <Clock size={12} className="text-text-muted" />;
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
