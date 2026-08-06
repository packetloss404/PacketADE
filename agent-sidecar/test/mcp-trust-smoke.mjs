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

// Probe stub: the unit assertions below are about the trust ALGEBRA, not about
// spawning servers. `mcp-trust-enforcement-smoke.mjs` drives the real prober
// against a real stdio MCP server.
const noProbe = async () => ({ ok: false, error: "probe disabled for this test" });

const frozen = await applyMcpTrustSnapshot({ files: server }, [base], projectPath, noProbe);
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
  Object.keys((await applyMcpTrustSnapshot({ files: server }, [], projectPath, noProbe)).servers),
  [],
);
assert.equal(
  (await applyMcpTrustSnapshot({ files: server }, undefined, projectPath, noProbe)).snapshots[0]
    ?.allowWrites,
  false,
);
assert.deepEqual(parseAnthropicMcpToolName("mcp__files__read_file"), {
  serverName: "files",
  toolName: "read_file",
});

// --- F6: read-only enforcement is an allowlist -----------------------------

// The exact names the 2026-08-05 review drove through the old 19-word
// substring denylist. Every one of them executed in a session the user had
// set to read-only.
const BYPASS_NAMES = [
  "edit_file",
  "apply_patch",
  "commit",
  "mkdir",
  "chmod",
  "exec",
  "git_commit",
  "append_to_file",
  "put_object",
  "save",
  "store",
  "modify",
  "insert_row",
  "drop_table",
];

for (const name of BYPASS_NAMES) {
  // Hostile framing: the user's allowlist contains the tool AND no capability
  // gate is set. The verb floor must still refuse it.
  const permissive = {
    ...base,
    capabilityCheckedAt: undefined,
    allowedToolNames: [...base.allowedToolNames, name],
  };
  const denial = mcpToolDenial("files", name, {}, [permissive]);
  assert.ok(denial, `read-only session allowed mutating tool '${name}'`);
  assert.match(denial, /read-only|denial floor/, `unexpected denial reason for '${name}'`);
}

// Unknown is not read-only: a tool that is neither obviously mutating, nor
// annotated by its server, nor granted by the user must fail closed.
const unverified = { ...base, capabilityCheckedAt: undefined, allowedToolNames: ["read_file"] };
assert.match(
  mcpToolDenial("files", "query_ledger", {}, [unverified]),
  /not verified read-only/,
  "unannotated, ungranted tool was allowed in a read-only session",
);
assert.equal(mcpToolDenial("files", "read_file", {}, [unverified]), null);

// The inversion is scoped to read-only sessions — a write-enabled server keeps
// its write tools, and the non-overridable floors still apply.
const writable = { ...base, allowWrites: true, capabilityCheckedAt: undefined };
assert.equal(mcpToolDenial("files", "write_file", { path: "src/main.ts" }, [writable]), null);
assert.equal(mcpToolDenial("files", "query_ledger", {}, [writable]), null);
assert.match(mcpToolDenial("files", "read_credentials", {}, [writable]), /denial floor/);

// camelCase names tokenize the same as snake_case ones.
assert.match(mcpToolDenial("files", "applyPatch", {}, [unverified]), /read-only/);
assert.match(mcpToolDenial("files", "insertRow", {}, [unverified]), /read-only/);

// A probe failure grants nothing: the snapshot keeps only what the user
// explicitly allowed, and everything else stays denied.
const unprobed = await applyMcpTrustSnapshot(
  { files: server },
  [{ ...base, capabilityCheckedAt: undefined, allowedToolNames: [] }],
  projectPath,
  noProbe,
);
assert.deepEqual(unprobed.snapshots[0].allowedToolNames, []);
assert.match(
  mcpToolDenial("files", "search_docs", {}, unprobed.snapshots),
  /not verified read-only/,
);

console.log("[mcp-trust-smoke] all assertions passed");
