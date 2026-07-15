import { useEffect } from "react";
import { RadioTower, RefreshCw, Globe, FolderOpen, Copy } from "lucide-react";
import { useMcpProviderStore } from "@/stores/mcpProviderStore";

export function McpProviderCard() {
  const config = useMcpProviderStore((s) => s.config);
  const tools = useMcpProviderStore((s) => s.tools);
  const resources = useMcpProviderStore((s) => s.resources);
  const serverStatus = useMcpProviderStore((s) => s.serverStatus);
  const serverError = useMcpProviderStore((s) => s.serverError);
  const serverBusy = useMcpProviderStore((s) => s.serverBusy);
  const setEnabled = useMcpProviderStore((s) => s.setEnabled);
  const setPort = useMcpProviderStore((s) => s.setPort);
  const setScope = useMcpProviderStore((s) => s.setScope);
  const toggleTool = useMcpProviderStore((s) => s.toggleTool);
  const syncServerStatus = useMcpProviderStore((s) => s.syncServerStatus);
  const refreshResources = useMcpProviderStore((s) => s.refreshResources);

  useEffect(() => {
    refreshResources();
    void syncServerStatus();
  }, [refreshResources, syncServerStatus]);

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
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v >= 1024 && v <= 65535) setPort(v);
          }}
          className="flex-1 bg-bg-secondary border border-bg-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-green w-20"
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
    </div>
  );
}
