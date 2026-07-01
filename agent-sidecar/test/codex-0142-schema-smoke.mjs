// Regression smoke for the OpenAI Codex provider against the codex-cli 0.135+
// "item"-based `exec --json` schema (captured from codex-cli 0.142.3). Prior to
// the fix the provider matched the flat 0.121 event names (`agent_message`,
// `task_complete`, …), so on 0.142 every event fell through unhandled and the
// agent produced NO output. This feeds the real 0.142 event stream through the
// provider's handleEvent and asserts text + tool calls + tokens are mapped.
//
// Run: node agent-sidecar/test/codex-0142-schema-smoke.mjs   (build dist first)

import { OpenAICodexProvider } from "../dist/providers/openai-codex.js";

// Real 0.142.3 `codex exec --json` output for: run `ls -1`, then summarize.
const EVENTS = [
  { type: "thread.started", thread_id: "019f1b3e-8168-7303-a12c-6ff7e947d6f2" },
  { type: "turn.started" },
  { type: "item.started", item: { id: "item_0", type: "command_execution", command: "/bin/zsh -lc 'ls -1'", aggregated_output: "", exit_code: null, status: "in_progress" } },
  { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "/bin/zsh -lc 'ls -1'", aggregated_output: "sample.txt\n", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Found one file: `sample.txt`." } },
  { type: "turn.completed", usage: { input_tokens: 27337, cached_input_tokens: 14592, output_tokens: 57, reasoning_output_tokens: 0 } },
];

const p = new OpenAICodexProvider();
p.sessionId = "s1"; // handleEvent needs a sessionId
const emitted = [];
for (const e of EVENTS) p.handleEvent(e, (ev) => emitted.push(ev));

const text = emitted.filter((e) => e.type === "chunk").map((e) => e.text).join("");
const toolStart = emitted.filter((e) => e.type === "tool_start").length;
const toolResult = emitted.find((e) => e.type === "tool_result");
const summary = emitted.find((e) => e.type === "turn_summary");

const failures = [];
if (!text.includes("sample.txt")) failures.push(`agent_message text not mapped to chunk (got: ${JSON.stringify(text)})`);
if (toolStart !== 1) failures.push(`expected 1 tool_start, got ${toolStart}`);
if (!toolResult || toolResult.output !== "sample.txt\n") failures.push(`tool_result output wrong: ${JSON.stringify(toolResult?.output)}`);
if (!summary || summary.inputTokens !== 27337 || summary.outputTokens !== 57) failures.push(`turn_summary tokens wrong: ${JSON.stringify(summary)}`);

if (failures.length > 0) {
  console.error("FAIL codex-0142-schema-smoke:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("PASS codex-0142-schema-smoke: text + tool_start + tool_result + tokens all mapped from 0.142 events");
