import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { RadioTower, RefreshCw, Copy, Activity, Check } from "lucide-react";
import { useMcpProviderStore } from "@/stores/mcpProviderStore";
import type { McpActivityEntry } from "@/lib/tauri";

export function McpProviderCard() {
  const config = useMcpProviderStore((s) => s.config);
  const resources = useMcpProviderStore((s) => s.resources);
  const serverStatus = useMcpProviderStore((s) => s.serverStatus);
  const serverError = useMcpProviderStore((s) => s.serverError);
  const serverBusy = useMcpProviderStore((s) => s.serverBusy);
  const activity = useMcpProviderStore((s) => s.activity);
  const setEnabled = useMcpProviderStore((s) => s.setEnabled);
  const setPort = useMcpProviderStore((s) => s.setPort);
  const setAllowWrites = useMcpProviderStore((s) => s.setAllowWrites);
  const tools = useMcpProviderStore((s) => s.tools);
  const toggleTool = useMcpProviderStore((s) => s.toggleTool);
  const syncAvailableTools = useMcpProviderStore((s) => s.syncAvailableTools);
  const syncServerStatus = useMcpProviderStore((s) => s.syncServerStatus);
  const refreshActivity = useMcpProviderStore((s) => s.refreshActivity);
  const pushActivity = useMcpProviderStore((s) => s.pushActivity);
  const refreshResources = useMcpProviderStore((s) => s.refreshResources);

  const running = serverStatus?.running ?? false;

  useEffect(() => {
    refreshResources();
    void syncAvailableTools();
    void syncServerStatus();
  }, [refreshResources, syncAvailableTools, syncServerStatus]);

  // `null` = no per-tool decision yet, which serves everything. Render that as
  // "all checked" so the checkbox state matches what the server actually does.
  const allowed = config.allowedTools;
  const isAllowed = (name: string) => allowed === null || allowed.includes(name);
  const allowedCount = tools.filter((t) => isAllowed(t.name)).length;

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
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <RadioTower size={12} className="text-accent-purple" />
          MCP Provider
          <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] font-normal text-text-muted">
            {resources.length} resource{resources.length !== 1 ? "s" : ""}
          </span>
        </h3>
        <button
          onClick={refreshResources}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary"
          title="Refresh Resources"
        >
          <RefreshCw size={11} />
          Refresh
        </button>
      </div>

      {/* Enable / Disable toggle */}
      <div className="mb-3 flex items-center justify-between rounded-lg border border-bg-border bg-bg-primary px-3 py-2">
        <span className="text-[11px] text-text-secondary">Enable MCP Provider</span>
        <button
          onClick={() => void setEnabled(!config.enabled)}
          disabled={serverBusy}
          className={`relative h-[18px] w-8 rounded-full transition-colors ${
            config.enabled ? "bg-accent-green" : "bg-bg-elevated"
          } ${serverBusy ? "cursor-wait opacity-50" : ""}`}
        >
          <span
            className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform ${
              config.enabled ? "left-[16px]" : "left-[2px]"
            }`}
          />
        </button>
      </div>

      {/* Running status + bearer token (paste into an external client's config) */}
      {serverError && (
        <div className="bg-accent-red/10 border-accent-red/30 mb-3 rounded-lg border px-3 py-2 text-[10px] text-accent-red">
          {serverError}
        </div>
      )}
      {serverStatus?.running && serverStatus.url && (
        <div className="border-accent-green/30 mb-3 space-y-1.5 rounded-lg border bg-bg-primary px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-green" />
            <span className="text-[10px] text-text-secondary">Running — Streamable HTTP</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-10 text-[10px] text-text-muted">URL</span>
            <code className="flex-1 truncate text-[10px] text-text-primary">
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
              <span className="w-10 text-[10px] text-text-muted">Token</span>
              <code className="flex-1 truncate text-[10px] text-text-primary">
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
      <div className="mb-3 flex items-center gap-3 rounded-lg border border-bg-border bg-bg-primary px-3 py-2">
        <label className="whitespace-nowrap text-[11px] text-text-secondary">Port</label>
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
          className="w-20 flex-1 rounded border border-bg-border bg-bg-secondary px-2 py-1 text-[11px] text-text-primary focus:border-accent-green focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      {/* Allow-writes toggle — opt-in; keeps the server read-only by default */}
      <div className="mb-4 flex items-center justify-between rounded-lg border border-bg-border bg-bg-primary px-3 py-2">
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
          className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${
            config.allowWrites ? "bg-accent-amber" : "bg-bg-elevated"
          } ${running ? "cursor-not-allowed opacity-50" : ""}`}
        >
          <span
            className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform ${
              config.allowWrites ? "left-[16px]" : "left-[2px]"
            }`}
          />
        </button>
      </div>

      {/* Per-tool allowlist.

          FAULT this fixes: these toggles used to exist, were persisted, and
          reached nothing — `mcp_server_start` only ever received the port and
          the allow-writes flag, so every provider tool was served to any
          authenticated client. They were then removed from the card, which
          left the settings persisted and still reading as a restriction.

          They are back because the Rust router now enforces them at BOTH
          `tools/list` and `tools/call` (`ToolRouter::disable_route`). The
          catalogue is read from the router itself, never hardcoded here, so
          the list shown can't drift from the list enforced. */}
      <div className="mb-4 rounded-lg border border-bg-border bg-bg-primary px-3 py-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] text-text-secondary">Available Tools</span>
          <span className="text-[10px] text-text-muted">
            {tools.length === 0 ? "reading…" : `${allowedCount} of ${tools.length}`}
          </span>
        </div>
        <p className="mb-2 text-[10px] leading-snug text-text-muted">
          {running
            ? "Frozen for this run — stop the server to change which tools it serves."
            : "Unchecked tools are neither listed to nor callable by connected clients."}
        </p>
        {tools.length === 0 ? (
          <div className="text-[10px] text-text-muted">
            Could not read the tool list from the backend, so none is claimed here.
          </div>
        ) : (
          <div className="max-h-44 space-y-0.5 overflow-y-auto">
            {tools.map((tool) => {
              const on = isAllowed(tool.name);
              return (
                <button
                  key={tool.name}
                  onClick={() => toggleTool(tool.name)}
                  disabled={running}
                  title={running ? "Stop the server to change this" : tool.description}
                  className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[10px] transition-colors ${
                    running ? "cursor-not-allowed opacity-50" : "hover:bg-bg-elevated"
                  }`}
                >
                  <span
                    className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-sm border ${
                      on
                        ? "border-accent-green bg-accent-green"
                        : "border-bg-border bg-bg-secondary"
                    }`}
                  >
                    {on && <Check size={8} className="text-bg-primary" />}
                  </span>
                  <code className="shrink-0 text-text-primary">{tool.name}</code>
                  <span className="truncate text-text-muted">{tool.description}</span>
                </button>
              );
            })}
          </div>
        )}
        {running && serverStatus && (
          <div className="mt-1.5 border-t border-bg-border pt-1.5 text-[10px] text-text-muted">
            Serving {serverStatus.servedTools.length} tool
            {serverStatus.servedTools.length === 1 ? "" : "s"}.
          </div>
        )}
      </div>

      {/* Live activity — tool calls / resource reads from external clients */}
      {running && (
        <div className="mt-3">
          <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
            <Activity size={11} className="text-accent-green" />
            Activity
          </h4>
          {activity.length === 0 ? (
            <div className="rounded-lg border border-bg-border bg-bg-primary px-3 py-2 text-[10px] text-text-muted">
              No requests yet.
            </div>
          ) : (
            <div className="max-h-40 space-y-0.5 overflow-y-auto">
              {activity
                .slice()
                .reverse()
                .map((entry) => (
                  <div
                    key={entry.seq}
                    className="flex items-center gap-2 rounded border border-bg-border bg-bg-primary px-3 py-1 text-[10px]"
                  >
                    <span
                      className={`rounded px-1 py-0.5 text-[9px] font-medium ${
                        entry.kind === "tool"
                          ? "bg-accent-blue/15 text-accent-blue"
                          : "bg-accent-purple/15 text-accent-purple"
                      }`}
                    >
                      {entry.kind}
                    </span>
                    <code className="flex-1 truncate text-text-primary">{entry.name}</code>
                    <span className="tabular-nums text-text-muted">
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
