import { useEffect } from "react";
import { RadioTower, RefreshCw, Globe, FolderOpen } from "lucide-react";
import { useMcpProviderStore } from "@/stores/mcpProviderStore";

export function McpProviderCard() {
  const config = useMcpProviderStore((s) => s.config);
  const tools = useMcpProviderStore((s) => s.tools);
  const resources = useMcpProviderStore((s) => s.resources);
  const setEnabled = useMcpProviderStore((s) => s.setEnabled);
  const setPort = useMcpProviderStore((s) => s.setPort);
  const setScope = useMcpProviderStore((s) => s.setScope);
  const toggleTool = useMcpProviderStore((s) => s.toggleTool);
  const refreshResources = useMcpProviderStore((s) => s.refreshResources);

  useEffect(() => {
    refreshResources();
  }, [refreshResources]);

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
          onClick={() => setEnabled(!config.enabled)}
          className={`relative w-8 h-[18px] rounded-full transition-colors ${
            config.enabled ? "bg-accent-green" : "bg-bg-elevated"
          }`}
        >
          <span
            className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
              config.enabled ? "left-[16px]" : "left-[2px]"
            }`}
          />
        </button>
      </div>

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
