import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { allowedMcpToolNames, mcpPathDenial, mcpToolDenial } from "./mcp-trust.js";
import type { McpTrustSnapshot } from "./protocol.js";

type ServerConfig = Record<string, unknown>;

type ProxyConfig = {
  serverName: string;
  server: ServerConfig;
  snapshot: McpTrustSnapshot;
};

function fail(message: string): never {
  process.stderr.write(`[mcp-trust-proxy] ${message}\n`);
  process.exit(1);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return [];
  }
  return value;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function decodeConfig(): ProxyConfig {
  const environmentName = process.argv[2];
  if (!environmentName) fail("missing configuration environment variable name");
  const encoded = process.env[environmentName];
  delete process.env[environmentName];
  if (!encoded) fail("missing configuration payload");

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    fail("invalid configuration payload");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("configuration payload must be an object");
  }
  const config = parsed as Partial<ProxyConfig>;
  if (
    typeof config.serverName !== "string" ||
    !config.server ||
    typeof config.server !== "object" ||
    Array.isArray(config.server) ||
    !config.snapshot ||
    config.snapshot.serverName !== config.serverName ||
    !config.snapshot.allowReads
  ) {
    fail("configuration payload failed trust validation");
  }
  return config as ProxyConfig;
}

function requestHeaders(server: ServerConfig): Record<string, string> | undefined {
  const headers = {
    ...stringRecord(server.httpHeaders),
    ...stringRecord(server.headers),
  };
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function targetTransport(config: ProxyConfig): Transport {
  const { server, snapshot } = config;
  if (server.type === "http" || server.type === "sse") {
    if (!snapshot.allowNetwork) {
      fail("network transport was not granted by the frozen trust snapshot");
    }
    if (typeof server.url !== "string" || server.url.length === 0) {
      fail("network transport is missing its URL");
    }
    const url = new URL(server.url);
    const headers = requestHeaders(server);
    if (server.type === "sse") {
      return new SSEClientTransport(url, {
        eventSourceInit: headers
          ? {
              fetch: (input, init) =>
                fetch(input, {
                  ...init,
                  headers: {
                    ...Object.fromEntries(new Headers(init?.headers).entries()),
                    ...headers,
                  },
                }),
            }
          : undefined,
        requestInit: headers ? { headers } : undefined,
      });
    }
    return new StreamableHTTPClientTransport(url, {
      requestInit: headers ? { headers } : undefined,
    });
  }

  if (typeof server.command !== "string" || server.command.length === 0) {
    fail("stdio transport is missing its command");
  }
  return new StdioClientTransport({
    command: server.command,
    args: stringArray(server.args),
    env: { ...getDefaultEnvironment(), ...stringRecord(server.env) },
    cwd: typeof server.cwd === "string" ? server.cwd : undefined,
    stderr: "inherit",
  });
}

const config = decodeConfig();
const client = new Client({ name: "mcp-trust-client", version: "1.0.0" });
await client.connect(targetTransport(config));

const targetCapabilities = client.getServerCapabilities();
const proxyCapabilities = {
  ...(targetCapabilities?.tools ? { tools: {} } : {}),
  ...(targetCapabilities?.resources ? { resources: {} } : {}),
  ...(targetCapabilities?.prompts ? { prompts: {} } : {}),
  ...(targetCapabilities?.completions ? { completions: {} } : {}),
};
const server = new Server(
  { name: "mcp-trust-proxy", version: "1.0.0" },
  { capabilities: proxyCapabilities },
);

if (targetCapabilities?.tools) {
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await client.listTools(request.params);
    const allowed = new Set(
      allowedMcpToolNames(
        config.snapshot,
        result.tools.map((tool) => tool.name),
      ) ?? [],
    );
    return { ...result, tools: result.tools.filter((tool) => allowed.has(tool.name)) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const denial = mcpToolDenial(
      config.serverName,
      request.params.name,
      request.params.arguments ?? {},
      [config.snapshot],
    );
    if (denial) {
      return {
        isError: true,
        content: [{ type: "text", text: denial }],
      };
    }
    return client.callTool(request.params);
  });
}

if (targetCapabilities?.resources) {
  server.setRequestHandler(ListResourcesRequestSchema, (request) =>
    client.listResources(request.params),
  );
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) =>
    client.listResourceTemplates(request.params),
  );
  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const denial = mcpPathDenial(config.snapshot, { path: request.params.uri });
    if (denial) throw new Error(denial);
    return client.readResource(request.params);
  });
}

if (targetCapabilities?.prompts) {
  server.setRequestHandler(ListPromptsRequestSchema, (request) =>
    client.listPrompts(request.params),
  );
  server.setRequestHandler(GetPromptRequestSchema, (request) => client.getPrompt(request.params));
}

if (targetCapabilities?.completions) {
  server.setRequestHandler(CompleteRequestSchema, (request) => client.complete(request.params));
}

const close = async (): Promise<void> => {
  await Promise.allSettled([server.close(), client.close()]);
};
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
await server.connect(new StdioServerTransport());
