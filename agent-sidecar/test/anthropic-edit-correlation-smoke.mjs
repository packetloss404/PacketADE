// Offline regression gate for Anthropic blocking-edit correlation.
//
// The Claude Agent SDK PreToolUse hook is parked under a tool-use ID. The
// pending_edit event must carry that exact ID so edit_response resolves the
// right hook. Omitting it leaves the Agent SDK turn waiting forever.

import assert from "node:assert/strict";
import { buildPendingEditEvent } from "../dist/providers/anthropic.js";

const event = buildPendingEditEvent(
  "anthropic-edit-correlation",
  "tool-write-42",
  "src/example.ts",
  "before\n",
  "after\n",
);

assert.deepEqual(event, {
  type: "pending_edit",
  sessionId: "anthropic-edit-correlation",
  toolUseId: "tool-write-42",
  path: "src/example.ts",
  before: "before\n",
  after: "after\n",
});

assert.throws(
  () =>
    buildPendingEditEvent(
      "anthropic-edit-correlation",
      "",
      "src/example.ts",
      "before\n",
      "after\n",
    ),
  /missing its tool-use ID/,
);

console.log(
  "PASS anthropic-edit-correlation-smoke: pending_edit carries the exact non-empty toolUseId required by edit_response",
);
