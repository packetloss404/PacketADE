// End-to-end v11 MCP trust enforcement (F6).
//
// Everything here runs against a REAL stdio MCP server (fixtures/
// mcp-trust-target.mjs), spawned by the real capability prober. Nothing is
// stubbed: if `applyMcpTrustSnapshot` stopped probing, or the prober stopped
// reading `readOnlyHint`, or the denial gate went back to guessing from tool
// names, these assertions fail.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The fixture server's own cold import of the MCP SDK can take a minute on a
// Windows/DrvFs checkout, which has nothing to do with what is under test.
// Give the probe room so a slow filesystem reads as slow, not as a failure.
process.env.PACKETADE_MCP_PROBE_TIMEOUT_MS ??= "180000";

import { probeMcpServerCapabilities } from "../dist/mcp-capability.js";
import { applyMcpTrustSnapshot, mcpToolDenial } from "../dist/mcp-trust.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectPath = path.resolve(here, "..");
const fixture = path.join(here, "fixtures", "mcp-trust-target.mjs");

const serverConfig = {
  type: "stdio",
  command: process.execPath,
  args: [fixture],
};

// --- 1. The prober reads real annotations off a real server ----------------

const probed = await probeMcpServerCapabilities("target", serverConfig, projectPath);
assert.equal(probed.ok, true, `capability probe failed: ${probed.error ?? ""}`);

const hints = new Map(probed.tools.map((tool) => [tool.name, tool.readOnlyHint]));
assert.deepEqual(
  [...hints.keys()].sort(),
  ["apply_patch", "query_ledger", "read_file", "write_file"],
  "prober did not see the fixture's full tool list",
);
assert.equal(hints.get("read_file"), true, "annotated read-only tool lost its hint");
assert.equal(hints.get("write_file"), false, "unannotated tool was reported read-only");
assert.equal(hints.get("query_ledger"), false, "unannotated tool was reported read-only");
assert.equal(hints.get("apply_patch"), true, "fixture's readOnlyHint claim was dropped");

// --- 2. A read-only session's allowlist is built from those annotations -----

const readOnlySnapshot = {
  schemaVersion: 1,
  serverId: "project:target",
  serverName: "target",
  workspacePath: projectPath,
  allowReads: true,
  allowWrites: false,
  allowNetwork: true,
  allowedRoots: [projectPath],
  allowedToolNames: [],
  denialFloors: ["credentials", "outside_workspace", "protected_publish"],
  revision: 1,
  updatedAt: Date.now(),
};

const frozen = await applyMcpTrustSnapshot(
  { target: serverConfig },
  [readOnlySnapshot],
  projectPath,
);
assert.deepEqual(Object.keys(frozen.servers), ["target"]);

const effective = frozen.snapshots[0];
assert.ok(
  effective.capabilityCheckedAt > 0,
  "probing a granted read-only server must stamp capabilityCheckedAt",
);
assert.ok(
  effective.allowedToolNames.includes("read_file"),
  "annotated read-only tool was not folded into the allowlist",
);
assert.ok(
  !effective.allowedToolNames.includes("write_file"),
  "unannotated tool leaked into the allowlist",
);
assert.ok(
  !effective.allowedToolNames.includes("query_ledger"),
  "unannotated tool leaked into the allowlist",
);

// --- 3. The denial gate honors it -----------------------------------------

assert.equal(
  mcpToolDenial("target", "read_file", { path: "package.json" }, frozen.snapshots),
  null,
  "annotated read-only tool was denied in a read-only session",
);

// Denied by the capability allowlist (it never earned a readOnlyHint) — and
// would be denied by the verb floor even if it had.
assert.match(
  mcpToolDenial("target", "write_file", { path: "package.json" }, frozen.snapshots),
  /frozen capability allowlist|read-only/,
  "mutating tool ran in a read-only session",
);

assert.match(
  mcpToolDenial("target", "query_ledger", { account: "x" }, frozen.snapshots),
  /frozen capability allowlist|not verified read-only/,
  "unannotated, ungranted tool ran in a read-only session",
);

// A server that annotates a mutating tool read-only does not get to grade its
// own homework: the verb floor outranks the annotation.
assert.match(
  mcpToolDenial("target", "apply_patch", { path: "package.json" }, frozen.snapshots),
  /read-only/,
  "a server's readOnlyHint overrode the mutating-verb floor",
);

// The path floor still fires on real arguments for an otherwise-allowed tool.
assert.match(
  mcpToolDenial(
    "target",
    "read_file",
    { path: path.join(projectPath, "..", "..", "secret.txt") },
    frozen.snapshots,
  ),
  /outside/,
  "path floor did not fire on an out-of-workspace argument",
);

// --- 4. An unreachable server contributes nothing --------------------------

const brokenConfig = { type: "stdio", command: process.execPath, args: ["--no-such-flag"] };
const brokenFrozen = await applyMcpTrustSnapshot(
  { target: brokenConfig },
  [readOnlySnapshot],
  projectPath,
);
assert.deepEqual(
  brokenFrozen.snapshots[0].allowedToolNames,
  [],
  "a server we could not probe must contribute no allowed tools",
);
assert.ok(
  mcpToolDenial("target", "read_file", {}, brokenFrozen.snapshots),
  "a server we could not probe must not run tools in a read-only session",
);

// --- 5. Write-enabled servers are not probed and keep their tools ----------

const writable = { ...readOnlySnapshot, allowWrites: true };
const writableFrozen = await applyMcpTrustSnapshot(
  { target: serverConfig },
  [writable],
  projectPath,
);
assert.equal(
  writableFrozen.snapshots[0].capabilityCheckedAt,
  undefined,
  "write-enabled servers should not be probed or capability-gated",
);
assert.equal(
  mcpToolDenial("target", "write_file", { path: "package.json" }, writableFrozen.snapshots),
  null,
  "enabling writes must still allow write tools",
);

// --- 6. The OpenAI provider re-checks arguments at invocation time ---------
//
// The SDK's `toolFilter` runs at LISTING time with no arguments, so it can
// never enforce the `outside_workspace` floor. These assertions drive the real
// `callTool` override against the real fixture server: the wrapper must refuse
// the out-of-workspace call before it ever reaches the server, and must let a
// legitimate call through untouched.

const { TrustEnforcingMcpServerStdio } = await import("../dist/providers/openai-agents.js");

const guarded = new TrustEnforcingMcpServerStdio("target", frozen.snapshots, {
  name: "target",
  command: process.execPath,
  args: [fixture],
  cwd: projectPath,
  cacheToolsList: true,
  // The Agents SDK defaults to a 5s MCP session timeout, which a cold DrvFs
  // module load blows through. Unrelated to what is under test here.
  clientSessionTimeoutSeconds: 180,
});

try {
  await guarded.connect();

  const escaped = await guarded.callTool("read_file", {
    path: path.join(projectPath, "..", "..", "secret.txt"),
  });
  assert.equal(escaped.length, 1);
  assert.equal(escaped[0].type, "text");
  assert.match(
    escaped[0].text,
    /outside/,
    "callTool ran an out-of-workspace path — the listing-time filter cannot catch this",
  );
  assert.ok(!escaped[0].text.startsWith("read:"), "the denied call still reached the MCP server");

  const blocked = await guarded.callTool("write_file", { path: "package.json" });
  assert.match(
    blocked[0].text,
    /frozen capability allowlist|read-only/,
    "callTool ran a mutating tool in a read-only session",
  );
  assert.ok(!blocked[0].text.startsWith("wrote:"), "the denied call still reached the server");

  // Control: an allowed call must actually execute, so we know the wrapper is
  // enforcing rather than simply blocking everything.
  const allowed = await guarded.callTool("read_file", { path: "package.json" });
  assert.equal(
    allowed[0].text,
    "read:package.json",
    "the wrapper blocked a call the trust snapshot permits",
  );
} finally {
  await guarded.close();
}

console.log("[mcp-trust-enforcement-smoke] all assertions passed");
