# Syndicate Proof Kit

Proof matrices and runbooks for the PacketADE ↔ Syndicate (controller relay)
integration, per the 2026-08-16 execution plan. Everything here is additive —
nothing in this directory modifies the PacketADE working tree, the Syndicate
source tree, or the PacketRelay repo.

## Hard rules

1. **`D:\projects\syndicate` is READ-ONLY.** Never edit it, never run
   npm/pnpm installs inside it. Where its tests must run, copy the repo
   (excluding `.git` and `node_modules`) elsewhere and run there.
2. **Production-safety rule.** Against the production relay
   (`packet-relay-1038865114903.us-central1.run.app`) exactly three read-only
   probes are permitted: `GET /healthz`, `GET /readyz`, and
   `packetrelay/scripts/smoke-cloud-run.py` (raw TLS/WSS upgrade check —
   sends **no** hello, so no route, no nonce, no admission). Everything else
   (`device_hello` / `host_hello`, test host connections, any RPC) runs
   against a **local** `packet-relay.exe` only. No exceptions without the
   owner.
3. **Method A edits the Host's STATE DB only** (`syndicate.db` under
   `~/.local/state/syndicate/` on the WSL/VM host). That is prescribed by the
   expiry runbook; the read-only prohibition covers only the source tree.
4. `method-b-request.md` is a draft **TO BE SENT BY THE OWNER** — it is never
   applied to the Syndicate tree by anyone here.

## Files

| File | What it is |
|---|---|
| `README.md` | This index. |
| `evidence-template.md` | Per-row evidence checklist (screenshots, HAR, localStorage, journal, sqlite dumps). |
| `00-fixture-parity.ps1` | Phase 0 A1 — SHA-256 parity across the three `controller-relay-crypto-v1` fixture copies. |
| `01-relay-readonly-probe.ps1` | Phase 0 A2 — the three permitted production probes. |
| `10-wsl-host-setup.sh` | WSL Ubuntu-26.04 host setup: deps, sshd, linger, published-installer Syndicate install, `doctor --json`. |
| `20-method-a.sh` | Method A sqlite helper: back up `syndicate.db`, set `controller_devices.grant_expires_at` variants, restore. |
| `30-vm-matrix.md` | Hyper-V Ubuntu 26.04 LTS Server runbook for the clean-install / upgrade / rollback / packaged-e2e rows. |
| `40-expiry-row-runbook.md` | The expiry-matrix execution order and per-row steps. |
| `method-b-request.md` | Draft request to Syndicate for short-lifetime test grants. **Owner sends; never applied locally.** |
| `phase0-results-2026-08-16.md` | Phase 0 execution record (written when Phase 0 runs). |

## Phases and buckets

- **Phase 0 (bucket a — all safe from Windows, run now):**
  - A0: PacketADE's own syndicate suites — `pnpm vitest run` on the four
    `syndicate*` test files + `cargo test syndicate` in `src-tauri`.
  - A1: `00-fixture-parity.ps1`.
  - A2: `01-relay-readonly-probe.ps1` (production read-only — explicitly permitted).
  - A3: `cargo test` in `D:\projects\packetrelay`.
  - A4: copy `D:\projects\syndicate` to a scratch dir, install, run the host
    workspace tests **in the copy**.
- **Phase 1 (WSL2):** `10-wsl-host-setup.sh`, then the Method-A expiry rows per
  `40-expiry-row-runbook.md`, evidencing each row per `evidence-template.md`.
- **Phase 2 (Hyper-V VM):** clean-install / boot / upgrade / rollback /
  packaged-e2e rows per `30-vm-matrix.md`. Needs a PacketADE version bump
  first for any packaged build (see drift notes).
- **Method B (blocked on Syndicate):** rows 5 / 5b / 6b need short-lifetime
  *signed* grants, which cannot be forged locally
  (`packetrelay` verifies the grant signature — `syndicate_relay.rs:374-379`).
  `method-b-request.md` is the ask.

## Execution order

1. Phase 0 (A1, A2, A3, A4, then A0 — A0 last, it is the slowest).
2. `10-wsl-host-setup.sh` on WSL Ubuntu-26.04.
3. Expiry rows in the order given in `40-expiry-row-runbook.md`
   (1, 2, 7, 3, 4, 6a, 8, 9, 10, then 11 last), then Method D pairing and the
   day-29 / day-31 calendar checks.
4. Rows 5 / 5b / 6b only after Syndicate answers `method-b-request.md`.
5. VM matrix (`30-vm-matrix.md`) once a version-bumped packaged build exists.

## Environment / role split

- **WSL2 Ubuntu-26.04** (systemd PID 1, x86_64) = expiry-matrix host and fast
  iteration copy.
- **Hyper-V Ubuntu 26.04 LTS Server VM** = clean-install / boot / upgrade /
  rollback sign-off rows.
- **Docker** does **not** satisfy the systemd / boot / cgroup rows — container
  runs are smoke only.
- **QEMU arm64** = smoke only, never sign-off.

## Drift notes (state of the world, 2026-08-16, re-verified 2026-08-25)

- **`backlog.md:143` is stale**: the PacketADE device-refresh proposal
  (PR #6, `packetade/device-refresh-proposal`) is **merged** upstream —
  `origin/main` is `baf1a3d`, while the local checkout sits at `d24d334`.
  Fetching/updating the local Syndicate checkout is the **owner's** call.
- **Typed-error seam (commit `53f98f83`) verified intact.** Anchors current:
  `src-tauri/src/commands/syndicate.rs:315` / `:1286-1303` / `:1747-1802`;
  `src/lib/syndicateErrors.ts:84-89`, `:104`;
  syndicate `apps/host/src/controller-auth.ts:420` (30-day lifetime literal),
  `:536` (auth predicate); packetrelay `syndicate_relay.rs:302`, `:335-338`,
  `:237`, `:233-235`; `SyndicateTerminalPane.tsx:216-222`;
  `src/lib/syndicateMachineStatus.ts:107` (`SYNDICATE_GRANT_WARNING_DAYS = 7`),
  `:117` (`Math.ceil` days-remaining).
- **Version bump required** before any packaged ST8 build: `package.json` and
  `src-tauri/tauri.conf.json` still read `0.10.5`, already shipped
  (`backlog.md:104`).
- **Rows 5/5b/6b are Method-B-only**: the relay grant is Ed25519-signed by the
  Host and verified by the relay (`syndicate_relay.rs:374-379`); a short-lived
  grant cannot be forged from outside.
- **Fixture gap**: `controller-relay-crypto-v1` pins the controller→Host
  crypto vectors but pins **neither** the `device_hello` vectors **nor** the
  grant-liveness literals (30-day lifetime, 7-day warning). Parity across the
  three copies proves shared crypto vectors, not liveness behaviour.
- **Installer version drift**: the 2026-08-16 plan text said "install
  Syndicate v0.1.3", but the Syndicate tree's `docs/LINUX_INSTALLER.md` now
  records **v0.2.1** as the live, verified release (and the workspace
  `package.json` is `0.2.1`). `10-wsl-host-setup.sh` defaults to `v0.2.1`;
  override with its `SYNDICATE_VERSION` env var if the owner wants another tag.
- **Package manager**: the plan sketch said `npm ci` / `npm test -w apps/host`,
  but Syndicate is a **pnpm** workspace (`packageManager: pnpm@10.33.0`,
  engines `node >=24.14.0`; root script `test = vitest run`; `apps/host` has no
  test script of its own). The equivalent used in Phase 0 A4 is
  `pnpm install --frozen-lockfile` + `pnpm exec vitest run apps/host` in the
  copy.

## Evidence conventions

Each executed row gets one folder `evidence/row-NN-<slug>/` (created at
execution time, not committed until the owner reviews) containing the items in
`evidence-template.md`, plus a filled copy of that template as `evidence.md`.
Phase 0 machine-run results live in `phase0-results-<date>.md` at this level.
