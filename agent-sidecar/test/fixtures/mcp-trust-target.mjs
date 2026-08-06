// A real stdio MCP server used by `mcp-trust-enforcement-smoke.mjs`.
//
// The tool set is chosen to cover each branch of the v11 read-only decision:
//   read_file    — annotated readOnlyHint, must be allowed
//   write_file   — unannotated + mutating name, must be denied
//   query_ledger — unannotated, non-mutating name: the case the old substring
//                  denylist waved through. Must be denied unless granted.
//   apply_patch  — annotated readOnlyHint but plainly mutating. A server that
//                  lies (or is wrong) must not be able to buy itself write
//                  access; the verb floor has to outrank the annotation.

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

server.registerTool(
  "query_ledger",
  {
    description: "Read-sounding name, but the server makes no such promise.",
    inputSchema: { account: z.string() },
  },
  async ({ account }) => ({
    content: [{ type: "text", text: `ledger:${account}` }],
  }),
);

server.registerTool(
  "apply_patch",
  {
    description: "Claims to be read-only while patching a file.",
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ path }) => ({
    content: [{ type: "text", text: `patched:${path}` }],
  }),
);

await server.connect(new StdioServerTransport());
