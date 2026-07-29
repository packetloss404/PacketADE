import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildCodexMcpLaunch } from "../dist/codex-mcp.js";
import {
  buildExecArgs,
  buildResumeArgs,
  modeToCodexFlags,
} from "../dist/providers/openai-codex.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectPath = path.resolve(here, "..");
const targetPath = path.join(here, "fixtures", "mcp-trust-target.mjs");
const proxyPath = path.join(here, "..", "dist", "mcp-trust-proxy.js");
const secret = "secret-that-must-never-appear-in-argv";
const snapshot = {
  schemaVersion: 1,
  serverId: "project:test",
  serverName: "test",
  workspacePath: projectPath,
  allowReads: true,
  allowWrites: false,
  allowNetwork: false,
  allowedRoots: [projectPath],
  allowedToolNames: ["read_file"],
  denialFloors: ["credentials", "outside_workspace", "protected_publish"],
  revision: 1,
  updatedAt: Date.now(),
  capabilityCheckedAt: Date.now(),
};
const request = {
  type: "start_session",
  sessionId: "codex-mcp-smoke",
  provider: "openai-codex",
  model: "gpt-test",
  systemPrompt: "",
  allowedTools: [],
  mcpServers: {
    test: {
      type: "stdio",
      command: process.execPath,
      args: [targetPath],
      env: { MCP_TEST_SECRET: secret },
    },
  },
  mcpTrustSnapshot: [snapshot],
  projectPath,
  initialMessage: "test",
};

const launch = buildCodexMcpLaunch(request, proxyPath);
assert.equal(Object.keys(launch.environment).length, 1);
assert.ok(Object.values(launch.environment)[0].length > secret.length);
assert.ok(!launch.configArgs.join(" ").includes(secret));
assert.ok(launch.configArgs.some((arg) => arg.includes("enabled_tools")));
assert.ok(launch.configArgs.some((arg) => arg.includes("required=true")));
assert.ok(launch.configArgs.some((arg) => arg.includes("shell_environment_policy.exclude")));

const sandbox = modeToCodexFlags("default");
for (const args of [
  buildExecArgs(request, "gpt-test", sandbox, launch.configArgs),
  buildResumeArgs("thread-id", request, "gpt-test", sandbox, launch.configArgs),
]) {
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes("--strict-config"));
  assert.ok(args.includes("plugins"));
  assert.ok(args.some((arg) => arg.includes("trust_level=\"untrusted\"")));
  assert.ok(!args.join(" ").includes(secret));
}

const [environmentName, encoded] = Object.entries(launch.environment)[0];
const client = new Client({ name: "codex-mcp-trust-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [proxyPath, environmentName],
  env: { ...process.env, [environmentName]: encoded },
  stderr: "inherit",
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["read_file"]);

  const allowed = await client.callTool({
    name: "read_file",
    arguments: { path: path.join(projectPath, "README.md") },
  });
  assert.equal(allowed.isError, undefined);

  const outside = await client.callTool({
    name: "read_file",
    arguments: { path: path.resolve(projectPath, "..", "outside.txt") },
  });
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /outside the frozen workspace roots/i);

  const hiddenWrite = await client.callTool({
    name: "write_file",
    arguments: { path: path.join(projectPath, "blocked.txt") },
  });
  assert.equal(hiddenWrite.isError, true);
  assert.match(hiddenWrite.content[0].text, /frozen capability allowlist/i);
} finally {
  await client.close();
}

console.log("PASS codex-mcp-trust-smoke: isolated config + filtered proxy enforcement");
