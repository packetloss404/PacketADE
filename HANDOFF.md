# PacketBench Handoff

Last reconciled: 2026-08-15

This is the restart document. It records the present state, the next decisions,
and the guardrails that must survive. Historical implementation narratives live
in `CHANGELOG.md`, the State report, and Git rather than being duplicated here.

## Restart state

- Branch: `main`, synchronized with `origin/main` at `a9d5d702`.
- Application version: `0.10.5`; sidecar protocol: `v11`.
- Worktree clean. Nothing uncommitted, nothing unpushed.
- Last two commits are this session's work:
  - `53f98f83` — the Syndicate grant-expiry fix and five other branch blockers.
  - `a9d5d702` — three Syndicate protocol/acceptance documents.
- `codex/syndicate-integration-toggle` was merged to `main` as a clean
  fast-forward and is pushed. It can be deleted whenever convenient.

## Latest Windows build

Built 2026-08-15 02:51 from `a9d5d702` with the Windows MSVC toolchain,
**unsigned**. Output is redirected to
`C:\Users\ianwalmsley\packetbench-build\release\bundle\`, not `src-tauri/target`.

| Artifact                                         | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `PacketBench_0.10.5_x64-setup.exe` (NSIS, 89.4 MB) | `8c0233fe31a5b39fef0c1e98082c392054610ab892e7053d0b7fb21985977303` |
| `PacketBench_0.10.5_x64_en-US.msi` (139.5 MB)      | `fca82769b8b48115d35294b2b84ed4346370c92c2804628e8859f7fac2387b45` |

**This is a development build, not a release.** It carries the `0.10.5` version
string that the artifacts recorded under `## [0.10.5]` in `CHANGELOG.md` already
use, while containing different code and hashing differently. Do not distribute
it. See Next item 1.

Tagging is also behind: `v0.10.3` is the newest annotated tag, so the last
tagged source remains `61e0669`, even though `CHANGELOG.md` records 0.10.4 and
0.10.5 as released. Anything reasoning from tags rather than from `CHANGELOG.md`
will conclude the tree is two releases younger than it is.

## What this session changed

The `codex/syndicate-integration-toggle` branch shipped a Settings switch for
the Syndicate integration, backed by a native fail-closed `AtomicBool` gate. A
cross-repo review found six blockers before merge; all six are fixed.

The substantive one was the **day-30 grant-expiry chain**. Syndicate grants last
30 days with no renewal path, so every paired device reaches it. The Host
answers an expired grant with `DEVICE_UNAUTHORIZED` while leaving the device's
status `active`, and PacketBench understood neither half: the terminal pane
matched fragments of the error _message_ and so retried a dead grant every five
seconds forever, the machines card kept advertising "Full coding control", and
nothing carried the grant's expiry so no warning was possible before the cliff.

`CONTROLLER_PROTOCOL_V1` has always answered with a typed `error.retryable` and
a stable `error.code`. PacketBench flattened both into a sentence and then tried
to read them back out of it. **That flattening was the actual defect**, and the
fix is at that seam: `SyndicateCommandError` carries the typed fields from Rust
to the frontend, retry branches on `retryable`, grant state branches on `code`.

Also fixed: the confirmation gradient was inverted (enabling restored full
controller authority unconfirmed while disabling sat behind a modal); the kill
switch disarmed its own remedy (`revoke` and `forgetOffline` threw while
disabled, leaving the grant live on the Host); a mount-time reset clobbered
restored pane state and reused a previous device's session identity after a
re-pair; `TerminalHeader` called `onKill` without awaiting or catching it.

## Verification status

| Gate                                    | Result                                             |
| --------------------------------------- | -------------------------------------------------- |
| `cargo test --lib`                      | 654 passed, 0 failed (Windows MSVC toolchain)      |
| `npx tsc --noEmit`                      | clean                                              |
| `pnpm lint`                             | 0 errors (9 pre-existing `react-refresh` warnings) |
| Affected frontend surface (17 files)    | 143 passed, 0 failed                               |
| Full `vitest run`                       | **never completed** — see Gotchas                  |
| Expiry path against real infrastructure | **never run** — see Next                           |

## Next

1. **Bump the version before any release build.** `package.json` and
   `src-tauri/tauri.conf.json` still read `0.10.5`, which has already shipped.
   The 2026-08-15 development build therefore produced installers labelled
   `0.10.5` that hash differently from the released ones. Both sets are in
   `CHANGELOG.md`. Nothing distinguishes them to a user or an updater, so **do
   not distribute the unreleased pair**, and move the version first.
2. **Run the expiry acceptance matrix.** The fix above is source- and
   unit-verified and has never met a real expired grant. Eleven rows, and four
   ways to produce an expired grant without waiting 30 days, are in
   [`dev/archive/syndicate/syndicate-expiry-acceptance.md`](./dev/archive/syndicate/syndicate-expiry-acceptance.md).
   This is the sharpest untested path in the integration.
3. **Chase Syndicate on `device.refresh`.** PacketBench's proposal is delivered
   (see below) and blocked on their answers. No client work starts until the
   method shape is settled.
4. **Hand the device→relay spec to Syndicate** for integration into
   `CONTROLLER_PROTOCOL_V1`, which today documents the controller→Host leg only.

## Cross-repo state (Syndicate)

PacketBench is the first client of Syndicate's controller protocol. The
integration is being kept and invested in, not removed. The working agreement is
`docs/PACKETBENCH_COORDINATION.md` in the Syndicate repo; **neither session writes
to the other's tree.**

Three documents were written here this session, all verified against source with
`file:line` citations rather than against existing documentation:

- [`dev/archive/syndicate/controller-protocol-device-relay-half.md`](./dev/archive/syndicate/controller-protocol-device-relay-half.md)
  — the device→relay half of the protocol, which exists nowhere else because we
  own the only implementation. Cross-checked against the relay's own
  `product_route.rs`, not just our side.
- [`dev/archive/syndicate/syndicate-device-refresh-proposal.md`](./dev/archive/syndicate/syndicate-device-refresh-proposal.md)
  — client input on the grant-renewal method Syndicate owns.
- [`dev/archive/syndicate/syndicate-expiry-acceptance.md`](./dev/archive/syndicate/syndicate-expiry-acceptance.md)
  — the acceptance matrix for the expiry fix.

The `device.refresh` proposal was **delivered on 2026-08-15** to
`packetloss404/syndicate` as branch `packetbench/device-refresh-proposal` (commit
`3844d3e`), branched from their `main`, adding one new file and modifying
nothing. It awaits their merge and answers to the six questions in its §10.

## Context — decisions made this session, so they are not relitigated

- **Fix the seam, not the symptom.** The obvious patch was adding
  `DEVICE_UNAUTHORIZED` to the message regex. That was rejected: the regex was
  itself the defect, and a seventh alternation would have left the next new code
  falling through the same gap. Retry now branches on the Host's typed
  `retryable`, which is strictly more correct — it also stops on
  `MACHINE_MISMATCH`, `INVALID_SIGNATURE`, `AUTH_REPLAY` and `REQUEST_EXPIRED`,
  and correctly keeps retrying `TERMINAL_RUNTIME_UNAVAILABLE` and
  `WORKSPACE_BUSY`, which the Host marks retryable.
- **Grant classification is typed-only, with no prose fallback.** An older
  native binary paired with new frontend code would stop detecting revocation.
  Every production path goes through the new native layer, so this is sound, but
  it is a deliberate choice rather than an oversight.
- **`SyndicateControllerError` is recognized by a brand field, not
  `instanceof`.** The error crosses a native boundary and is rebuilt from a
  plain object; a second copy of the module (test module reset, HMR) would
  silently stop matching and downgrade a fatal verdict back to an infinite
  retry.
- **Revocation and local forget deliberately bypass the kill switch**, at both
  the store and the native boundary. Disabling the integration is what a user
  does on suspicion of compromise; if that also disarmed revocation the grant
  would stay live until it expired. Revoking while disabled raises the managed
  forward briefly and closes it again.
- **`deny_unknown_fields` was relaxed on `PairClaimResponse` /
  `PairClaimDevice` only.** The protocol pins the pairing _invitation_
  field-by-field with a shared fixture but says nothing about the claim
  response, so strictness there could have broken pairing on shipped builds from
  any additive Host change. The invitation envelope stays strict on purpose.

## Gotchas

- **Frozen fixtures — do not edit or rename-sweep.**
  `src-tauri/tests/fixtures/controller-pairing-invitation-v1.json` and
  `controller-relay-crypto-v1.json` are byte-identical to Syndicate's copies by
  design and loaded by both repos as conformance vectors. The pairing fixture
  contains the literal `"displayName": "PacketBench controller"` and a
  `relayEndpoint`; **neither may be updated** — not by the PacketBench rename,
  not when the relay changes hostname. Their value is the byte-identity, not the
  accuracy of the strings inside. Exclude both before running rename tooling.
  A `DO NOT EDIT` block sits above the test that loads them.
- **`pnpm rust:check` fails in WSL.** The GTK/webkit dev packages Tauri needs
  are not installed, and `pkg-config` is absent. Use the Windows toolchain
  instead, which is what actually builds this app:
  `/mnt/c/Users/ianwalmsley/.cargo/bin/cargo.exe check --manifest-path 'D:\projects\packetbench\src-tauri\Cargo.toml'`.
  Note `cargo` is not on PATH for non-interactive shells; export
  `PATH="$HOME/.cargo/bin:$PATH"` for the Linux one.
- **`node_modules` here is a Linux install.** A Windows `pnpm tauri build`
  requires a Windows `pnpm install` first, which swaps the platform-specific
  binaries and breaks the WSL test suite until a WSL `pnpm install` restores it.
  Both were run on 2026-08-15 and the environment is currently restored to
  Linux. `pnpm tauri build` also runs `scripts/prune-sidecar.js`, a destructive
  hoisted prod-only reinstall — re-run `pnpm sidecar:install` afterwards.
- **Release output is redirected.** Installers land in
  `C:\Users\ianwalmsley\packetbench-build\release\bundle\`, not under
  `src-tauri/target`.
- **Vitest worker startup times out intermittently on DrvFs.** A full
  `vitest run` collapsed with `Failed to start threads worker` on most files;
  the same files pass when run in small sets. Prefer `--pool=threads` and a
  handful of files at a time. A failure that reads
  `Timeout waiting for worker to respond` is environmental, not a test failure.
- **`git status` is unreliable in this clone.** On `/mnt/d` (DrvFs) hundreds of
  files show as modified on line endings alone. Use
  `git diff --ignore-cr-at-eol --numstat` to see real changes.
- **`handoff.md` and `HANDOFF.md` are the same file.** DrvFs is
  case-insensitive; Git tracks it as `HANDOFF.md`.
- **Expiry data only arrives on the relay path.** The Host puts `expiresAt`
  inside the relay grant, so SSH-only pairings report `unknown` rather than a
  countdown. That is honest, not a bug, but it means the warning cannot cover
  every pairing.
- **Revoke cannot succeed on an expired grant.** `syndicate_revoke_self` is
  itself a signed RPC, which the Host rejects with `DEVICE_UNAUTHORIZED`. Local
  "forget" is the only cleanup path in that state, which is why the machine row
  carries an explicit forget-locally action.
