import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mcp-trust-target", version: "1.0.0" });

server.registerTool(
  "read_file",
  {
    description: "Return the requested path.",
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ path }) => ({
    content: [{ type: "text", text: `read:${path}` }],
  }),
);

server.registerTool(
  "write_file",
  {
    description: "Pretend to write the requested path.",
    inputSchema: { path: z.string() },
  },
  async ({ path }) => ({
    content: [{ type: "text", text: `wrote:${path}` }],
  }),
);

await server.connect(new StdioServerTransport());
