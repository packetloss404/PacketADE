import assert from "node:assert/strict";
import { SessionRegistry } from "../dist/session-registry.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function startReq(sessionId) {
  return {
    type: "start_session",
    sessionId,
    provider: "controlled",
    model: "",
    systemPrompt: "",
    allowedTools: [],
    mcpServers: {},
    projectPath: process.cwd(),
    initialMessage: "initial",
  };
}

class ControlledProvider {
  constructor(events, gates) {
    this.events = events;
    this.gates = gates;
    this.sessionId = "";
  }

  async start(req, emit) {
    this.sessionId = req.sessionId;
    this.events.push(`${req.sessionId}:start:begin`);
    await this.gates.get(req.sessionId).promise;
    this.events.push(`${req.sessionId}:start:end`);
    emit({
      type: "done",
      sessionId: req.sessionId,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  async sendMessage(req, emit) {
    this.events.push(`${req.sessionId}:send:${req.content}`);
    emit({
      type: "done",
      sessionId: req.sessionId,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  async close() {
    this.events.push(`${this.sessionId}:close`);
  }
}

const events = [];
const emitted = [];
const gates = new Map([
  ["a", deferred()],
  ["b", deferred()],
]);

const registry = new SessionRegistry({
  controlled: () => new ControlledProvider(events, gates),
});
const emit = (event) => emitted.push(event);

const aStart = registry.start(startReq("a"), emit);
const aSend = registry.dispatch(
  "a",
  { type: "send_message", sessionId: "a", content: "first" },
  emit,
);
const aClose = registry.close("a");
const bStart = registry.start(startReq("b"), emit);

await nextTurn();

assert.deepEqual(events, ["a:start:begin", "b:start:begin"]);

gates.get("b").resolve();
await bStart;

assert.equal(events.includes("a:send:first"), false);
assert.equal(events.includes("a:close"), false);
assert.ok(
  events.indexOf("b:start:end") > events.indexOf("b:start:begin"),
  "unrelated session should complete while the first session is still starting",
);

gates.get("a").resolve();
await Promise.all([aStart, aSend, aClose]);

assert.deepEqual(
  events.filter((event) => event.startsWith("a:")),
  ["a:start:begin", "a:start:end", "a:send:first", "a:close"],
);
assert.equal(
  emitted.some(
    (event) =>
      event.type === "error" &&
      event.sessionId === "a" &&
      event.message.startsWith("No active session:"),
  ),
  false,
);

console.log("[session-ordering-smoke] PASS");
