# Session Resume — resumed 2026-07-19

Live continuation note for the P1/P2 fix loop. Git state was re-verified before
resuming: `main` is clean at `5bbf0c5`, with G33 and F53 merged.

## Fix-loop status (spec: `dev/p1-p2-fix-loop-spec.md`, workflow: `dev/p1-p2-fix-loop.workflow.js`)

| Item | Branch | Status |
|---|---|---|
| G33 | `fix/g33-stop-requeue` | ✅ Committed `722e316`, gate passed, 2 adversarial reviews SOUND (zero findings). **Merged to main 2026-07-19.** |
| F53 | `fix/f53-cross-arch-sidecar` | ✅ Committed + **merged to main 2026-07-19**. Both reviews SOUND, zero findings (incl. confirming the temporary `pnpm.supportedArchitectures` injection in prune-sidecar.js is the spec design — no persistent package.json change — and vitest.config.ts over vite.config.ts was correct). Gate: full vitest 954/955; the 1 failure (`persistenceMigration.test.ts` ideation timeout) reproduces on clean main — pre-existing, unrelated (worth a standalone look: 5s testTimeout too tight for WSL). |
| G01 | `fix/g01-sidecar-exit-hook` | ✅ Implemented; `cargo check --lib` and `pnpm run build` pass. The Windows test binary compiles but the local loader exits before the harness with `STATUS_ENTRYPOINT_NOT_FOUND`, so the manual quit/process-tree smoke remains required. |
| sshpw-P2 | (branch deleted, clean) | ❌ Not started |
| G09 | (branch deleted, clean) | ❌ Not started |
| deploy-P2 | — | ⏸ Deliberately skipped — **needs user A/B decision** (A: delete dead `commands/deploy.rs` family, closes F22/23/24/25/39; B: re-surface UI). Run with `args:{deploy:"delete"}` for A. |

The remaining order is G01 → sshpw-P2 → G09. Do not re-run the already-merged
G33/F53 items. Deploy-P2 remains skipped until the user chooses deletion or a UI
rebuild.

Gate note: full vitest on the WSL-mounted drive is very slow; use `--maxWorkers=4`.
Commit trailer required by spec: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## After the loop (agreed sequencing)

1. Merge the five `fix/*` branches into main, push.
2. User decides deploy-P2 (A/B above); if A, run it as a sixth item.
3. Regenerate CLAUDE.md — it is gitignored/untracked and badly stale (says protocol
   v6, real is v8; Agents tab deleted → ConversationTiles; etc.). Full drift list is
   §5 of `dev/codebase-state-2026-07-16.md`. Decide whether to re-commit it to the repo.
4. User decisions blocking roadmap: R0 Remote Agents 3 Sprint-0 decisions
   (`dev/remoteagents/09-open-decisions.md`: auth provider, E2EE timing, code
   location, ~5 weeks stale); R2 = buy Win+macOS signing certs.
5. Loose: live Codex-over-SSH smoke (step 12, `dev/sidecar-over-ssh-verification.md`);
   residual items in backlog.md's 83-finding register; stash `agent-leak-from-W5-run`
   on main (only copy of that work — inspect or drop).

## Other state from this session

- Line endings: repo converged to LF (`ca2e248`, 172 files) with new `.gitattributes`
  (`* text=auto eol=lf`). Use `git blame --ignore-rev ca2e248`. Other machines will
  see one-time churn on pull.
- Full codebase survey (8 readers) produced `dev/codebase-state-2026-07-16.md`
  — accurate architecture map of main @ ca2e248, feeds R1 docs work.
- Anunta enterprise exploration: strategy brief produced (research + 5-persona focus
  group). Kept OUT of the repo deliberately (negotiation-sensitive); stored in the
  Claude memory dir. Headlines: pitch as agentic runbook-automation console (not an
  IDE); 4 pilot-gating builds = managed policy file, persisted audit log,
  proxy/custom-CA, signed MSI; resolve IP ownership in writing BEFORE showing code;
  dual-license/open-core is legally clean (sole copyright holder, verified).
