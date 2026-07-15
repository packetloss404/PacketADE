import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { RadioTower, RefreshCw, Globe, FolderOpen, Copy, Activity } from "lucide-react";
import { useMcpProviderStore } from "@/stores/mcpProviderStore";
import type { McpActivityEntry } from "@/lib/tauri";

export function McpProviderCard() {
  const config = useMcpProviderStore((s) => s.config);
  const tools = useMcpProviderStore((s) => s.tools);
  const resources = useMcpProviderStore((s) => s.resources);
  const serverStatus = useMcpProviderStore((s) => s.serverStatus);
  const serverError = useMcpProviderStore((s) => s.serverError);
  const serverBusy = useMcpProviderStore((s) => s.serverBusy);
  const activity = useMcpProviderStore((s) => s.activity);
  const setEnabled = useMcpProviderStore((s) => s.setEnabled);
  const setPort = useMcpProviderStore((s) => s.setPort);
  const setScope = useMcpProviderStore((s) => s.setScope);
  const setAllowWrites = useMcpProviderStore((s) => s.setAllowWrites);
  const toggleTool = useMcpProviderStore((s) => s.toggleTool);
  const syncServerStatus = useMcpProviderStore((s) => s.syncServerStatus);
  const refreshActivity = useMcpProviderStore((s) => s.refreshActivity);
  const pushActivity = useMcpProviderStore((s) => s.pushActivity);
  const refreshResources = useMcpProviderStore((s) => s.refreshResources);

  const running = serverStatus?.running ?? false;

  useEffect(() => {
    refreshResources();
    void syncServerStatus();
  }, [refreshResources, syncServerStatus]);

  // Live audit feed: fetch the backlog once running, then stream new accesses.
  useEffect(() => {
    if (!running) return;
    void refreshActivity();
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<McpActivityEntry>("mcp-server-activity", (event) => {
      pushActivity(event.payload);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        console.warn("listen(mcp-server-activity) failed", err);
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [running, refreshActivity, pushActivity]);

  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-text-primary flex items-center gap-2">
          <RadioTower size={12} className="text-accent-purple" />
          MCP Provider
          <span className="text-[10px] text-text-muted font-normal px-1.5 py-0.5 bg-bg-elevated rounded">
            {resources.length} resource{resources.length !== 1 ? "s" : ""}
          </span>
        </h3>
        <button
          onClick={refreshResources}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-muted hover:text-text-primary transition-colors"
          title="Refresh Resources"
        >
          <RefreshCw size={11} />
          Refresh
        </button>
      </div>

      {/* Enable / Disable toggle */}
      <div className="flex items-center justify-between bg-bg-primary border border-bg-border rounded-lg px-3 py-2 mb-3">
        <span className="text-[11px] text-text-secondary">Enable MCP Provider</span>
        <button
          onClick={() => void setEnabled(!config.enabled)}
          disabled={serverBusy}
          className={`relative w-8 h-[18px] rounded-full transition-colors ${
            config.enabled ? "bg-accent-green" : "bg-bg-elevated"
          } ${serverBusy ? "opacity-50 cursor-wait" : ""}`}
        >
          <span
            className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
              config.enabled ? "left-[16px]" : "left-[2px]"
            }`}
          />
        </button>
      </div>

      {/* Running status + bearer token (paste into an external client's config) */}
      {serverError && (
        <div className="mb-3 px-3 py-2 bg-accent-red/10 border border-accent-red/30 rounded-lg text-[10px] text-accent-red">
          {serverError}
        </div>
      )}
      {serverStatus?.running && serverStatus.url && (
        <div className="mb-3 px-3 py-2 bg-bg-primary border border-accent-green/30 rounded-lg space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />
            <span className="text-[10px] text-text-secondary">Running — Streamable HTTP</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-text-muted w-10">URL</span>
            <code className="flex-1 text-[10px] text-text-primary truncate">
              {serverStatus.url}
            </code>
            <button
              onClick={() => void navigator.clipboard.writeText(serverStatus.url ?? "")}
              className="text-text-muted hover:text-text-primary"
              title="Copy URL"
            >
              <Copy size={11} />
            </button>
          </div>
          {serverStatus.token && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-text-muted w-10">Token</span>
              <code className="flex-1 text-[10px] text-text-primary truncate">
                {serverStatus.token}
              </code>
              <button
                onClick={() => void navigator.clipboard.writeText(serverStatus.token ?? "")}
                className="text-text-muted hover:text-text-primary"
                title="Copy bearer token"
              >
                <Copy size={11} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Port input */}
      <div className="flex items-center gap-3 bg-bg-primary border border-bg-border rounded-lg px-3 py-2 mb-3">
        <label className="text-[11px] text-text-secondary whitespace-nowrap">Port</label>
        <input
          type="number"
          min={1024}
          max={65535}
          value={config.port}
          disabled={running}
          title={running ? "Stop the server to change the port" : undefined}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v >= 1024 && v <= 65535) setPort(v);
          }}
          className="flex-1 bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-green w-20 disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>

      {/* Scope selector */}
      <div className="flex items-center gap-3 bg-bg-primary border border-bg-border rounded-lg px-3 py-2 mb-4">
        <span className="text-[11px] text-text-secondary whitespace-nowrap">Scope</span>
        <div className="flex gap-1">
          <button
            onClick={() => setScope("project")}
            className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors ${
              config.scope === "project"
                ? "bg-accent-blue/15 text-accent-blue border border-accent-blue/30"
                : "text-text-muted hover:text-text-primary hover:bg-bg-hover border border-transparent"
            }`}
          >
            <FolderOpen size={10} />
            Project
          </button>
          <button
            onClick={() => setScope("global")}
            className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors ${
              config.scope === "global"
                ? "bg-accent-green/15 text-accent-green border border-accent-green/30"
                : "text-text-muted hover:text-text-primary hover:bg-bg-hover border border-transparent"
            }`}
          >
            <Globe size={10} />
            Global
          </button>
        </div>
      </div>

      {/* Allow-writes toggle — opt-in; keeps the server read-only by default */}
      <div className="flex items-center justify-between bg-bg-primary border border-bg-border rounded-lg px-3 py-2 mb-4">
        <div className="min-w-0 pr-2">
          <div className="text-[11px] text-text-secondary">Allow writes</div>
          <div className="text-[10px] text-text-muted">
            Lets agents post append-only handoff notes. Off = strictly read-only.
          </div>
        </div>
        <button
          onClick={() => setAllowWrites(!config.allowWrites)}
          disabled={running}
          title={running ? "Stop the server to change this" : undefined}
          className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 ${
            config.allowWrites ? "bg-accent-amber" : "bg-bg-elevated"
          } ${running ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <span
            className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
              config.allowWrites ? "left-[16px]" : "left-[2px]"
            }`}
          />
        </button>
      </div>

      {/* Tools list */}
      <div className="mb-2">
        <h4 className="text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-2">
          Available Tools ({config.allowedTools.length}/{tools.length} enabled)
        </h4>
        <div className="space-y-1">
          {tools.map((tool) => {
            const enabled = config.allowedTools.includes(tool.name);
            return (
              <label
                key={tool.name}
                className="flex items-start gap-2 px-3 py-2 bg-bg-primary border border-bg-border rounded-lg cursor-pointer hover:bg-bg-hover transition-colors"
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => toggleTool(tool.name)}
                  className="mt-0.5 accent-accent-green"
                />
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-text-primary">{tool.name}</div>
                  <div className="text-[10px] text-text-muted">{tool.description}</div>
                </div>
              </label>
            );
          })}
        </div>
      </div>

      {/* Live activity — tool calls / resource reads from external clients */}
      {running && (
        <div className="mt-3">
          <h4 className="text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Activity size={11} className="text-accent-green" />
            Activity
          </h4>
          {activity.length === 0 ? (
            <div className="text-[10px] text-text-muted px-3 py-2 bg-bg-primary border border-bg-border rounded-lg">
              No requests yet.
            </div>
          ) : (
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {activity
                .slice()
                .reverse()
                .map((entry) => (
                  <div
                    key={entry.seq}
                    className="flex items-center gap-2 px-3 py-1 bg-bg-primary border border-bg-border rounded text-[10px]"
                  >
                    <span
                      className={`px-1 py-0.5 rounded text-[9px] font-medium ${
                        entry.kind === "tool"
                          ? "bg-accent-blue/15 text-accent-blue"
                          : "bg-accent-purple/15 text-accent-purple"
                      }`}
                    >
                      {entry.kind}
                    </span>
                    <code className="flex-1 text-text-primary truncate">{entry.name}</code>
                    <span className="text-text-muted tabular-nums">
                      {new Date(entry.at).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
