// Deterministic regression coverage for G09. No Codex installation or network
// access is required: argv builders are exercised directly and the watchdog
// launches a silent Node fixture through the provider's normal spawn path.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenAICodexProvider,
  buildExecArgs,
  buildResumeArgs,
  modeToCodexFlags,
} from "../dist/providers/openai-codex.js";

const request = {
  type: "start_session",
  sessionId: "g09",
  provider: "api-openai-codex",
  model: "",
  systemPrompt: "",
  allowedTools: [],
  mcpServers: {},
  projectPath: process.cwd(),
  initialMessage: "test",
};

for (const mode of [
  undefined,
  null,
  "default",
  "plan",
  "acceptEdits",
  "deny_all",
  "bypassPermissions",
]) {
  const flags = modeToCodexFlags(mode);
  for (const args of [flags.execArgs, flags.resumeArgs]) {
    assert.equal(args.includes("-a"), false, `${mode} emitted unsupported -a`);
    assert.equal(
      args.includes("--ask-for-approval"),
      false,
      `${mode} emitted unsupported --ask-for-approval`,
    );
  }
}

const safeFlags = modeToCodexFlags("default");
const execArgs = buildExecArgs(request, "gpt-test", safeFlags);
const resumeArgs = buildResumeArgs("thread-id", request, "gpt-test", safeFlags);
assert.equal(execArgs.includes("--sandbox"), true, "fresh exec lost sandbox flag");
assert.equal(execArgs.includes("approval_policy=never"), true, "fresh exec can prompt");
assert.equal(resumeArgs.includes("--sandbox"), false, "resume rejects --sandbox");
assert.equal(
  resumeArgs.includes("sandbox_mode=workspace-write"),
  true,
  "resume lost sandbox config",
);
assert.equal(resumeArgs.includes("approval_policy=never"), true, "resume can prompt");

const approvalProvider = new OpenAICodexProvider();
approvalProvider.sessionId = "approval-session";
let stdinWrites = 0;
approvalProvider.child = {
  exitCode: null,
  stdin: { write: () => stdinWrites++ },
};
const approvalEvents = [];
await approvalProvider.respondPermission(
  {
    type: "permission_response",
    sessionId: "approval-session",
    toolUseId: "tool-1",
    decision: "approve",
  },
  (event) => approvalEvents.push(event),
);
assert.equal(stdinWrites, 0, "respondPermission wrote to closed codex stdin");
assert.equal(approvalEvents.length, 1);
assert.equal(approvalEvents[0].type, "error");
assert.match(approvalEvents[0].message, /non-interactive/);

const injectedEvents = [];
approvalProvider.handleEvent(
  { type: "exec_approval_request", id: "approval-1", command: "echo nope" },
  (event) => injectedEvents.push(event),
);
assert.equal(
  injectedEvents.some((event) => event.type === "permission_request"),
  false,
  "unsupported approval event escaped to the UI",
);

const fixtureDir = await mkdtemp(join(tmpdir(), "codex-watchdog-"));
try {
  // `process.execPath exec ...` treats this extensionless file as its script;
  // every Codex argv becomes an ignored script argument.
  await writeFile(join(fixtureDir, "exec"), "setInterval(() => {}, 1000);\n");
  const watchdogProvider = new OpenAICodexProvider(75);
  const watchdogEvents = [];
  const timeoutError = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("watchdog did not fire")), 3000);
    watchdogProvider.start(
      {
        ...request,
        sessionId: "watchdog-session",
        projectPath: fixtureDir,
        commandPath: process.execPath,
      },
      (event) => {
        watchdogEvents.push(event);
        if (event.type === "error" && /no stdout/.test(event.message)) {
          clearTimeout(timer);
          resolve(event);
        }
      },
    );
  });
  await timeoutError;
  await new Promise((resolve) => setTimeout(resolve, 100));
  await watchdogProvider.close();
  assert.equal(
    watchdogEvents.filter((event) => event.type === "error" && /no stdout/.test(event.message))
      .length,
    1,
    "watchdog emitted more than one terminal error",
  );
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

console.log("PASS codex-permission-nohang-smoke: argv + approval + watchdog regressions covered");
