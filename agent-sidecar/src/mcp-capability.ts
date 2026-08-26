// Per-session MCP capability probe (F6).
//
// The v11 trust snapshot decides whether a tool may run, but the snapshot the
// host freezes only knows what the user configured — it does not know what the
// server actually exposes. For a read-only session that gap is the whole ball
// game: without ground truth about which tools are non-mutating, the only
// honest options are "deny everything" or "guess from the tool's name", and the
// name guess is exactly the fail-open hole this module closes.
//
// So at session start we connect to each granted MCP server, call `tools/list`,
// and record each tool's `readOnlyHint` annotation. `mcp-trust.ts` folds the
// annotated read-only tools into the snapshot's `allowedToolNames`, and
// everything else is denied for the life of the session.
//
// A probe failure is NOT a pass. A server we could not interrogate contributes
// no allowed tools, which means a read-only session gets nothing from it.

// The MCP client SDK is imported lazily, inside the probe. It is a large
// module graph and this file is reachable from the sidecar's startup path via
// `mcp-trust.ts`; paying that load before the `ready` handshake would delay
// every session start (and, on cold Windows/DrvFs installs, delay it by tens
// of seconds) for sessions that may configure no MCP servers at all.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** One tool as the server itself describes it. */
export interface ProbedTool {
  name: string;
  /** True only when the server explicitly annotated `readOnlyHint: true`.
   * An absent annotation is `false` — unknown is not read-only. */
  readOnlyHint: boolean;
}

export type McpCapabilityProbeResult =
  | { ok: true; tools: ProbedTool[] }
  | { ok: false; error: string };

/** Injectable so tests can drive `applyMcpTrustSnapshot` without spawning. */
export type McpCapabilityProbe = (
  serverName: string,
  server: Record<string, unknown>,
  projectPath: string,
) => Promise<McpCapabilityProbeResult>;

// Generous on purpose. The probe pays a cold module load in the server's own
// process, which on Windows/DrvFs installs can take tens of seconds the first
// time. Timing out means denying every tool from that server, so the budget
// errs toward waiting rather than toward silently losing MCP.
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/// Read at call time so slow hosts can raise the budget without a rebuild.
/// A too-short budget fails CLOSED — the server's tools all become
/// unavailable — so this is the knob to reach for when a legitimate MCP
/// server is being denied on a slow machine.
function probeTimeoutMs(): number {
  const raw = Number(process.env.PACKETBENCH_MCP_PROBE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROBE_TIMEOUT_MS;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

async function buildTransport(
  server: Record<string, unknown>,
  projectPath: string,
): Promise<Transport | { error: string }> {
  const type = server.type === "http" || server.type === "sse" ? server.type : "stdio";

  if (type === "stdio") {
    if (typeof server.command !== "string" || server.command.length === 0) {
      return { error: "stdio server has no command" };
    }
    const args = Array.isArray(server.args)
      ? server.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const env = stringRecord(server.env);
    const { getDefaultEnvironment, StdioClientTransport } =
      await import("@modelcontextprotocol/sdk/client/stdio.js");
    return new StdioClientTransport({
      command: server.command,
      args,
      // The SDK's default environment is a deliberately small allowlist; the
      // server's own `env` block is layered on top exactly as the providers
      // spawn it, so the probe sees the same tool surface the session will.
      env: { ...getDefaultEnvironment(), ...(env ?? {}) },
      cwd: projectPath || undefined,
      stderr: "ignore",
    });
  }

  if (typeof server.url !== "string" || server.url.length === 0) {
    return { error: `${type} server has no url` };
  }
  let url: URL;
  try {
    url = new URL(server.url);
  } catch (err) {
    return { error: `${type} server has an unparseable url: ${errorMessage(err)}` };
  }
  const headers = stringRecord(server.headers);
  const requestInit = headers ? { headers } : undefined;
  if (type === "http") {
    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    return new StreamableHTTPClientTransport(url, { requestInit });
  }
  const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
  return new SSEClientTransport(url, { requestInit });
}

/**
 * Connect to one MCP server, list its tools, and report each tool's
 * `readOnlyHint`. Never throws; every failure mode becomes `{ ok: false }`.
 */
export const probeMcpServerCapabilities: McpCapabilityProbe = async (
  serverName,
  server,
  projectPath,
) => {
  let transport: Transport | { error: string };
  let client: Client;
  try {
    transport = await buildTransport(server, projectPath);
    if ("error" in transport) {
      return { ok: false, error: transport.error };
    }
    const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
    client = new McpClient(
      { name: "packetbench-trust-probe", version: "1.0.0" },
      { capabilities: {} },
    );
  } catch (err) {
    return { ok: false, error: `${serverName}: ${errorMessage(err)}` };
  }

  const budgetMs = probeTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `capability probe timed out after ${budgetMs}ms — raise ` +
              `PACKETBENCH_MCP_PROBE_TIMEOUT_MS if this server is simply slow to start`,
          ),
        ),
      budgetMs,
    );
    timer.unref?.();
  });

  try {
    const listed = await Promise.race([
      (async () => {
        await client.connect(transport);
        return await client.listTools();
      })(),
      timeout,
    ]);
    const tools: ProbedTool[] = (listed.tools ?? []).map((tool) => ({
      name: tool.name,
      readOnlyHint: tool.annotations?.readOnlyHint === true,
    }));
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, error: `${serverName}: ${errorMessage(err)}` };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await client.close();
    } catch {
      // Best effort — the transport may already be dead.
    }
  }
};
