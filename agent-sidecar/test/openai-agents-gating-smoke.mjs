// Risky-tool gating unit test for the OpenAI Agents SDK provider.
//
// Issue #2 — "gate risky tools under 'auto'". Implementer A changed
// `needsPermission(name, input)` in src/providers/openai-agents.ts so that the
// default 'auto' permission mode now pauses for an explicit approval before
// running the risky tools `bash` and `write_file` (previously 'auto' ran them
// silently). `write_file` under `approveWrites` is deliberately exempt from the
// SDK-level prompt because it has its own single `pending_edit` approval gate —
// the no-double-prompt case.
//
// WHY A MIRROR INSTEAD OF DRIVING THE REAL DECISION?
// `needsPermission` is a PRIVATE method wired into the OpenAI Agents SDK as the
// per-tool `needsApproval` callback. Exercising it through the SDK requires a
// live OpenAI API key + network + the real agent runtime to reach the approval
// branch — none of which is permitted for a deterministic offline smoke test,
// and the provider exports no helper we could call directly. So this test:
//   1. Re-implements the decision logic as a LOCAL MIRROR (decideNeedsApproval /
//      decideToolBlocked below) that is a line-for-line copy of the provider's
//      `needsPermission` + the risky-tool branch of `assertToolAllowed`.
//   2. Guards against silent drift by reading the provider SOURCE and asserting
//      the load-bearing decision branches are still present verbatim. If
//      Implementer A's logic is ever refactored, the source-guard fails loudly
//      and forces this mirror to be updated alongside it.
//
// No network, no API key, no SDK runtime. Pure decision-table assertions.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RISKY_TOOLS = new Set(["bash", "write_file"]);
const PLAN_MODE_ALLOWED = new Set(["read_file", "list_directory", "grep"]);

let failures = 0;
function check(label, actual, expected) {
  if (actual !== expected) {
    failures += 1;
    console.error(
      `[openai-agents-gating-smoke] FAIL: ${label} — expected ${JSON.stringify(
        expected,
      )}, got ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`[openai-agents-gating-smoke] PASS: ${label}`);
  }
}

// ---------------------------------------------------------------------------
// LOCAL MIRROR of OpenAIAgentsProvider.needsPermission (openai-agents.ts).
// Keep byte-for-byte equivalent to the provider; the source-guard below
// enforces that the provider still contains these exact branches.
// ---------------------------------------------------------------------------
function decideNeedsApproval(name, state) {
  if (!RISKY_TOOLS.has(name)) return false;
  if (state.planMode || state.permissionMode === "deny_all") return false;
  if (state.permissionMode === "allow_all") return false;
  if (state.autoAllowedTools.has(name)) return false;
  if (name === "write_file" && state.approveWrites) return false;
  return (
    state.permissionMode === "ask_for_risky" || state.permissionMode === "auto"
  );
}

// LOCAL MIRROR of the risky-tool branch of assertToolAllowed: a risky tool is
// hard-blocked at execute time (throws, never runs) under plan mode or deny_all.
function decideToolBlocked(name, state) {
  if (state.planMode && !PLAN_MODE_ALLOWED.has(name)) return true;
  if (RISKY_TOOLS.has(name) && state.permissionMode === "deny_all") return true;
  return false;
}

function makeState(overrides = {}) {
  return {
    planMode: false,
    permissionMode: "auto",
    approveWrites: false,
    autoAllowedTools: new Set(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Source-guard: the mirror is only meaningful if it still matches the provider.
// ---------------------------------------------------------------------------
function guardSourceUnchanged() {
  const src = readFileSync(
    resolve(__dirname, "..", "src", "providers", "openai-agents.ts"),
    "utf8",
  );
  const requiredFragments = [
    // needsPermission decision branches
    'if (!RISKY_TOOLS.has(name)) return false;',
    'if (this.planMode || this.permissionMode === "deny_all") return false;',
    'if (this.permissionMode === "allow_all") return false;',
    'if (this.autoAllowedTools.has(name)) return false;',
    'if (name === "write_file" && this.approveWrites) return false;',
    'this.permissionMode === "ask_for_risky" || this.permissionMode === "auto"',
    // assertToolAllowed risky-tool blocking
    'if (RISKY_TOOLS.has(name) && this.permissionMode === "deny_all") {',
    'const RISKY_TOOLS = new Set(["bash", "write_file"]);',
  ];
  for (const fragment of requiredFragments) {
    if (!src.includes(fragment)) {
      failures += 1;
      console.error(
        `[openai-agents-gating-smoke] FAIL: provider source no longer contains ` +
          `the gating branch:\n    ${fragment}\n  The local mirror in this test ` +
          `has drifted from openai-agents.ts and MUST be updated.`,
      );
    }
  }
  if (failures === 0) {
    console.log(
      `[openai-agents-gating-smoke] PASS: provider source still matches the mirrored gating logic`,
    );
  }
}

guardSourceUnchanged();

// ---------------------------------------------------------------------------
// Decision matrix.
// ---------------------------------------------------------------------------

// Headline fix: auto + bash → requires an approval prompt (was FALSE before).
check(
  "auto + bash requires approval",
  decideNeedsApproval("bash", makeState({ permissionMode: "auto" })),
  true,
);
check(
  "auto + bash is NOT hard-blocked (it prompts, then runs on approve)",
  decideToolBlocked("bash", makeState({ permissionMode: "auto" })),
  false,
);

// auto + write_file with approveWrites OFF → SDK approval prompt fires.
check(
  "auto + write_file (approveWrites off) requires approval",
  decideNeedsApproval(
    "write_file",
    makeState({ permissionMode: "auto", approveWrites: false }),
  ),
  true,
);

// No-double-prompt: auto + write_file with approveWrites ON → NO SDK prompt;
// the single approval gate is the pending_edit diff round-trip.
check(
  "auto + write_file (approveWrites ON) does NOT raise an SDK approval (pending_edit is the only gate)",
  decideNeedsApproval(
    "write_file",
    makeState({ permissionMode: "auto", approveWrites: true }),
  ),
  false,
);
// bash has no pending_edit path, so approveWrites must not suppress its prompt.
check(
  "auto + bash still requires approval even when approveWrites ON",
  decideNeedsApproval(
    "bash",
    makeState({ permissionMode: "auto", approveWrites: true }),
  ),
  true,
);

// ask_for_risky parity with auto for the risky tools.
check(
  "ask_for_risky + bash requires approval",
  decideNeedsApproval("bash", makeState({ permissionMode: "ask_for_risky" })),
  true,
);
check(
  "ask_for_risky + write_file (approveWrites off) requires approval",
  decideNeedsApproval(
    "write_file",
    makeState({ permissionMode: "ask_for_risky", approveWrites: false }),
  ),
  true,
);

// allow_all → auto-run, no approval prompt.
check(
  "allow_all + bash does NOT require approval",
  decideNeedsApproval("bash", makeState({ permissionMode: "allow_all" })),
  false,
);
check(
  "allow_all + write_file does NOT require approval",
  decideNeedsApproval("write_file", makeState({ permissionMode: "allow_all" })),
  false,
);

// allow_always memo: once a tool is in autoAllowedTools it stops prompting.
check(
  "auto + bash after allow_always does NOT re-prompt",
  decideNeedsApproval(
    "bash",
    makeState({ permissionMode: "auto", autoAllowedTools: new Set(["bash"]) }),
  ),
  false,
);

// deny_all → needsApproval is FALSE here, but the tool is HARD-BLOCKED at
// execute time, so it is never silently run.
check(
  "deny_all + bash does NOT raise an SDK approval prompt",
  decideNeedsApproval("bash", makeState({ permissionMode: "deny_all" })),
  false,
);
check(
  "deny_all + bash is hard-blocked at execute time",
  decideToolBlocked("bash", makeState({ permissionMode: "deny_all" })),
  true,
);
check(
  "deny_all + write_file is hard-blocked at execute time",
  decideToolBlocked("write_file", makeState({ permissionMode: "deny_all" })),
  true,
);

// plan mode → no approval prompt AND risky tools are hard-blocked.
check(
  "planMode + bash does NOT raise an SDK approval prompt",
  decideNeedsApproval("bash", makeState({ planMode: true })),
  false,
);
check(
  "planMode + bash is hard-blocked at execute time",
  decideToolBlocked("bash", makeState({ planMode: true })),
  true,
);
check(
  "planMode + write_file is hard-blocked at execute time",
  decideToolBlocked("write_file", makeState({ planMode: true })),
  true,
);

// Non-risky tools never prompt and are never blocked (except plan-mode rule,
// which still allows read_file / list_directory / grep).
for (const tool of ["read_file", "list_directory", "grep"]) {
  check(
    `non-risky ${tool} never requires approval (auto)`,
    decideNeedsApproval(tool, makeState({ permissionMode: "auto" })),
    false,
  );
  check(
    `non-risky ${tool} is not blocked in plan mode`,
    decideToolBlocked(tool, makeState({ planMode: true })),
    false,
  );
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[openai-agents-gating-smoke] FAIL: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log(`\n[openai-agents-gating-smoke] OK`);
process.exit(0);
