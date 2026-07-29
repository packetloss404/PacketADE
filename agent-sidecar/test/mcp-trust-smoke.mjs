import assert from "node:assert/strict";
import {
  applyMcpTrustSnapshot,
  mcpToolDenial,
  parseAnthropicMcpToolName,
} from "../dist/mcp-trust.js";

const projectPath = process.platform === "win32" ? "D:\\work\\app" : "/work/app";
const server = { type: "stdio", command: "node", args: ["server.js"] };
const base = {
  schemaVersion: 1,
  serverId: "project:files",
  serverName: "files",
  workspacePath: projectPath,
  allowReads: true,
  allowWrites: false,
  allowNetwork: true,
  allowedRoots: [projectPath],
  allowedToolNames: ["read_file", "write_file", "push_release"],
  denialFloors: ["credentials", "outside_workspace", "protected_publish"],
  revision: 1,
  updatedAt: 1,
  capabilityCheckedAt: 1,
};

const frozen = applyMcpTrustSnapshot({ files: server }, [base], projectPath);
assert.deepEqual(Object.keys(frozen.servers), ["files"]);
assert.equal(mcpToolDenial("files", "read_file", { path: "src/main.ts" }, frozen.snapshots), null);
assert.match(
  mcpToolDenial("files", "write_file", { path: "src/main.ts" }, frozen.snapshots),
  /read-only/,
);
assert.match(
  mcpToolDenial("files", "push_release", {}, [{ ...base, allowWrites: true }]),
  /denial floor/,
);
assert.match(
  mcpToolDenial("files", "read_file", { path: "../secret.txt" }, frozen.snapshots),
  /outside/,
);
assert.deepEqual(
  Object.keys(applyMcpTrustSnapshot({ files: server }, [], projectPath).servers),
  [],
);
assert.equal(
  applyMcpTrustSnapshot({ files: server }, undefined, projectPath).snapshots[0]?.allowWrites,
  false,
);
assert.deepEqual(parseAnthropicMcpToolName("mcp__files__read_file"), {
  serverName: "files",
  toolName: "read_file",
});

console.log("[mcp-trust-smoke] all assertions passed");
