// COMPLETED 2026-07-19. Historical executable record only; do not relaunch.
export const meta = {
  name: 'p1-p2-fix-loop',
  description: 'Autonomous fix loop for F53/G01/G09/G33 + deploy & SSH-password P2s. One item per branch: implement -> 2 adversarial reviews -> fix -> gate -> commit. Reads dev/p1-p2-fix-loop-spec.md.',
  phases: [
    { title: 'G33' }, { title: 'deploy-P2' }, { title: 'F53' },
    { title: 'G01' }, { title: 'sshpw-P2' }, { title: 'G09' },
  ],
}

// LAUNCH:
//   Workflow({ scriptPath: "dev/p1-p2-fix-loop.workflow.js" })                    -> runs all items, SKIPS deploy-P2
//   Workflow({ scriptPath: "dev/p1-p2-fix-loop.workflow.js", args: { deploy: "delete" } }) -> also amputates the dead deploy family
// The deploy-P2 A/B decision (delete vs re-surface UI) is the user's; default here is SKIP until args.deploy === "delete".

const SPEC_FILE = "dev/p1-p2-fix-loop-spec.md"

const CONTEXT = [
  "PROJECT: PacketADE at /Users/ianwalmsley/projects/PacketADE. Tauri v2: Rust in src-tauri/, React/TS in src/, Node sidecar in agent-sidecar/.",
  "",
  "The FULL launch-ready spec is at " + SPEC_FILE + " — READ IT FIRST. It has one pinned section per item (root cause, exact file:line edits, tests, gate, risks). Do NOT re-derive; follow the spec.",
  "",
  "GATE commands (run the ones the item's spec lists; all must pass before commit): (cd src-tauri && cargo check --lib) ; (cd src-tauri && cargo test --lib) ; pnpm run check:tauri-schema ; pnpm run lint:src ; pnpm run build ; pnpm test -- --run ; and pnpm run sidecar:check for sidecar changes. NOTE: the pre-existing openai-codex registry-smoke failure (codex CLI rejects -a) is ENVIRONMENTAL — for the G09 item it should be RESOLVED by the fix; for other items ignore it as pre-existing. Do NOT run preflight/format:check. NEVER prettier on src/.",
  "",
  "COMMIT: end every commit body with exactly: Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
].join("\n")

const ALL_ITEMS = [
  { key: "G33", branch: "fix/g33-stop-requeue", deploy: false },
  { key: "deploy-P2", branch: "refactor/deploy-amputate-p2", deploy: true },
  { key: "F53", branch: "fix/f53-cross-arch-sidecar", deploy: false },
  { key: "G01", branch: "fix/g01-sidecar-exit-hook", deploy: false },
  { key: "sshpw-P2", branch: "fix/sshpw-askpass-unix", deploy: false },
  { key: "G09", branch: "fix/g09-codex-nohang", deploy: false },
]

const includeDeploy = args && args.deploy === "delete"
const ITEMS = ALL_ITEMS.filter((it) => !it.deploy || includeDeploy)
if (!includeDeploy) log("deploy-P2 SKIPPED (launch with args:{deploy:'delete'} to include it). Running " + ITEMS.length + " items.")

const results = []
for (const it of ITEMS) {
  phase(it.key)

  const impl = await agent(
    CONTEXT +
      "\n\nBUILD ITEM " + it.key + " now. FIRST run: git checkout main && git pull --ff-only 2>/dev/null; git checkout -b " + it.branch + " (each item gets its OWN branch off main). Then Read " + SPEC_FILE + " and implement ONLY the '" + it.key + "' section — its exact file:line edits and tests. Stay strictly in scope; do not touch other items. Then run the item's GATE (per its spec) and iterate until every gate command passes. Then commit on " + it.branch + " with a clear conventional message + the Co-Authored-By trailer. Report: files changed, gate results (pass/fail per command), commit hash (git rev-parse HEAD), and anything incomplete.",
    { label: "build:" + it.key, phase: it.key },
  )

  const reviewLens = (lens) =>
    CONTEXT +
    "\n\nADVERSARIALLY REVIEW the just-committed " + it.key + " on branch " + it.branch + ". Read the diff: git show --stat HEAD ; git diff main...HEAD. The spec section is in " + SPEC_FILE + " (item " + it.key + "); the implementer reported:\n\n" + (impl || "(no report)") +
    "\n\nLENS: " + lens + ". Find REAL correctness/security/regression bugs only, and confirm the fix actually matches the spec's intent and stays in scope. For each finding: file:line + concrete failure scenario + severity. If sound on your lens, say so. No style nits. Verify against the real code."

  const reviews = await parallel([
    () => agent(reviewLens("CORRECTNESS + does-it-truly-fix-the-bug + no scope creep"), { label: "review:" + it.key + "-a", phase: it.key }),
    () => agent(reviewLens("REGRESSION + security + tests actually assert the new behavior"), { label: "review:" + it.key + "-b", phase: it.key }),
  ])

  const fix = await agent(
    CONTEXT +
      "\n\nApply fixes to " + it.key + " on branch " + it.branch + " from these two reviews. Act only on CONFIRMED real issues; skip false positives/style (say which and why). Re-run the item GATE until green, then commit/amend the fixes with the trailer. If nothing real was found, make no change and say so.\n\nREVIEW A:\n" + (reviews[0] || "(none)") + "\n\nREVIEW B:\n" + (reviews[1] || "(none)") +
      "\n\nReport: fixed vs skipped (with reasons), final gate results, final commit hash on " + it.branch + ".",
    { label: "fix:" + it.key, phase: it.key },
  )

  results.push({ item: it.key, branch: it.branch, impl, reviews, fix })
  log(it.key + " done on " + it.branch)
}

return { itemsRun: ITEMS.map((i) => i.key), branches: ITEMS.map((i) => i.branch), results }
