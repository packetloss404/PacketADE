import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { McpTrustSnapshot, StartSessionRequest } from "./protocol.js";
import { allowedMcpToolNames } from "./mcp-trust.js";

const MAX_PROXY_ENV_BYTES = 24 * 1024;
const PROXY_ENV_PREFIX = "MCP_TRUST_PROXY_";

type ServerConfig = Record<string, unknown>;

type ProxyConfig = {
  serverName: string;
  server: ServerConfig;
  snapshot: McpTrustSnapshot;
};

export type CodexMcpLaunch = {
  configArgs: string[];
  environment: Record<string, string>;
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

function configOverride(key: string, value: string): string[] {
  return ["-c", `${key}=${value}`];
}

function proxyServerName(serverName: string): string {
  return `trusted_${Buffer.from(serverName, "utf8").toString("base64url")}`;
}

function proxyEnvironmentName(index: number, serverName: string): string {
  const suffix = createHash("sha256").update(serverName).digest("hex").slice(0, 10);
  return `${PROXY_ENV_PREFIX}${index}_${suffix}`;
}

function isServerConfig(value: unknown): value is ServerConfig {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function codexSessionBoundaryArgs(projectPath: string): string[] {
  const args = [
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--disable",
    "plugins",
  ];
  if (projectPath) {
    args.push(
      ...configOverride(`projects.${tomlString(projectPath)}.trust_level`, tomlString("untrusted")),
    );
  }
  return args;
}

export function buildCodexMcpLaunch(
  req: StartSessionRequest,
  proxyScriptPath = fileURLToPath(new URL("./mcp-trust-proxy.js", import.meta.url)),
): CodexMcpLaunch {
  const configArgs: string[] = [];
  const environment: Record<string, string> = {};
  const snapshots = new Map(
    (req.mcpTrustSnapshot ?? []).map((snapshot) => [snapshot.serverName, snapshot]),
  );
  const proxyEnvironmentNames: string[] = [];
  let totalEnvironmentBytes = 0;

  for (const [serverName, value] of Object.entries(req.mcpServers ?? {})) {
    if (!isServerConfig(value)) continue;
    const snapshot = snapshots.get(serverName);
    if (!snapshot?.allowReads) continue;

    const transport = value.type === "http" || value.type === "sse" ? value.type : "stdio";
    if (transport !== "stdio" && !snapshot.allowNetwork) continue;

    const proxyName = proxyServerName(serverName);
    const environmentName = proxyEnvironmentName(proxyEnvironmentNames.length, serverName);
    const payload: ProxyConfig = { serverName, server: value, snapshot };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    totalEnvironmentBytes += Buffer.byteLength(environmentName) + Buffer.byteLength(encoded);
    if (totalEnvironmentBytes > MAX_PROXY_ENV_BYTES) {
      throw new Error(
        `MCP trust proxy configuration exceeds the ${MAX_PROXY_ENV_BYTES}-byte session limit`,
      );
    }
    environment[environmentName] = encoded;
    proxyEnvironmentNames.push(environmentName);

    const key = `mcp_servers.${tomlString(proxyName)}`;
    configArgs.push(
      ...configOverride(`${key}.command`, tomlString(process.execPath)),
      ...configOverride(`${key}.args`, tomlArray([proxyScriptPath, environmentName])),
      ...configOverride(`${key}.env_vars`, tomlArray([environmentName])),
      ...configOverride(`${key}.enabled`, "true"),
      ...configOverride(`${key}.required`, "true"),
      ...configOverride(`${key}.default_tools_approval_mode`, tomlString("approve")),
    );
    const enabledTools = allowedMcpToolNames(snapshot);
    if (enabledTools !== undefined) {
      configArgs.push(...configOverride(`${key}.enabled_tools`, tomlArray(enabledTools)));
    }
  }

  if (proxyEnvironmentNames.length > 0) {
    configArgs.push(
      ...configOverride("shell_environment_policy.exclude", tomlArray(proxyEnvironmentNames)),
    );
  }

  return { configArgs, environment };
}
