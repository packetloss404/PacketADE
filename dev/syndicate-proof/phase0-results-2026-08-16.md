# Phase 0 results — executed 2026-08-25

Plan of record: the 2026-08-16 Syndicate proof plan (bucket a — all checks
safe from Windows). Executed on the Windows host, PacketBench branch
`feat/acp-transport-and-agent-visuals` with unrelated uncommitted WIP present
(read-only for this exercise).

## Tool versions

| Tool | Version |
|---|---|
| Node | v24.14.1 |
| pnpm (PATH) | 9.15.4 — the Syndicate copy resolved and used **pnpm v10.33.0** per its `packageManager` field |
| Python | 3.13.12 |
| cargo / rustc | 1.94.1 |
| Vitest (PacketBench) | 4.1.2 |
| Vitest (Syndicate copy) | 4.1.10 |
| PowerShell used for probes | Windows PowerShell 5.1 (`powershell.exe`) |

## A1 — fixture parity (`00-fixture-parity.ps1`) — PASS

All three copies are byte-identical, SHA-256:

```
3EA33BFBEFC5F05DF41CAC1CB04718D5EF42133614897BB9AE35DF42BA739B5D  (1820 bytes)
```

| Copy | Path |
|---|---|
| PacketBench | `D:\projects\PacketADE\src-tauri\tests\fixtures\controller-relay-crypto-v1.json` |
| Syndicate | `D:\projects\syndicate\docs\fixtures\controller-relay-crypto-v1.json` |
| PacketRelay | `D:\projects\packetrelay\testdata\controller_relay_crypto_v1.json` |

Known gap (by design of the fixture, restated by the script): it pins the
controller→Host crypto vectors only — neither the `device_hello` vectors nor
the grant-liveness literals (30-day lifetime, 7-day warning).

## A2 — production relay read-only probes (`01-relay-readonly-probe.ps1`) — PARTIAL PASS

Only the three permitted probes were sent. Results:

| Probe | Expected | Observed |
|---|---|---|
| `GET /healthz` | 200 | **404** (empty body) |
| `GET /readyz` | 200 | **200**, body `ready` |
| `smoke-cloud-run.py wss://…/v1/product-route` (no hello) | HTTP/1.1 101 | **101** — "WSS product-route upgrade verified" |

**Caveat — `/healthz` 404.** Current packetrelay **source** routes `/healthz`
to the health handler (`src/main.rs:505`), and `deploy.sh:83` even uses it as
the Cloud Run liveness probe, so the deployed production revision appears to
**predate the `/healthz` alias** (README/CHANGELOG describe `/healthz`+`/readyz`
as internal probes and `/health`+`/ready` as the public smoke pair).
`GET /health` was **not** probed — it is not one of the three permitted
production probes. Relay is demonstrably up (readyz 200, upgrade 101);
the 404 is a deployment-revision drift for the owner to confirm/redeploy,
not a relay outage. Verdict: readyz + smoke PASS, healthz FAIL-as-specified
(plan expected 200/200).

## A3 — PacketRelay `cargo test` — PASS

`D:\projects\packetrelay`, `cargo test` (repo not modified):

```
Running unittests src/main.rs (packet_relay-cbc597693f7ceb04.exe)
test result: ok. 61 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.26s
```

Single test binary; includes the fixture-driven crypto vectors
(`room_auth::tests::golden_signed_hello_payload_vector`,
`product_route::tests::ephemeral_listener_authenticates_host_and_device_and_stamps_opaque_frame`).

## A4 — Syndicate host workspace tests (in a COPY) — PASS with a Windows-only cleanup caveat

The read-only rule was observed: `D:\projects\syndicate` was copied
(`robocopy /E /XD .git node_modules`, 6218 files / 1.456 GB) to the session
scratchpad (`…\scratchpad\syndicate-copy`) and everything ran in the copy.

Plan drift: the plan sketched `npm ci && npm test -w apps/host`, but the repo
is a **pnpm** workspace (`packageManager: pnpm@10.33.0`; root `test` =
`vitest run`; `apps/host` has no test script). Equivalent commands used:

```
pnpm install --frozen-lockfile   # Done in 36.4s using pnpm v10.33.0
pnpm exec vitest run apps/host
```

Full `apps/host` run:

```
Test Files  1 failed | 16 passed (17)
     Tests  10 failed | 133 passed | 2 skipped (145)
  Duration  98.81s
```

All 10 failures are in **one** file, `apps/host/src/server.test.ts`
("reviewed worktree disposition" describe), and every one is the same
Windows-only teardown error, not an assertion failure:

```
Error: EPERM, Permission denied: \\?\C:\Users\...\Temp\syndicate-disposition-XXXXXX
  apps/host/src/server.test.ts:86:50   (afterEach rmSync(directory, { recursive ... }))
```

i.e. `rmSync` on the per-test temp worktree dirs hits Windows file locking
(open sqlite/worktree handles). The Host targets Linux; on its supported
platform this teardown is expected to pass. Not a Syndicate logic failure.

The three suites the plan names as the host proof surface were additionally
run in isolation and **pass clean**:

```
pnpm exec vitest run apps/host/src/controller-auth.test.ts \
  apps/host/src/controller-contract.test.ts \
  apps/host/src/controller-relay-crypto.test.ts

Test Files  3 passed (3)
     Tests  16 passed (16)
  Duration  6.71s
```

The original `D:\projects\syndicate` tree was not touched at any point.

## A0 — PacketBench's own syndicate suites — PASS (Rust needed one retry, see below)

Run last (slowest; touches the main tree read-only).

### Frontend (vitest) — PASS

```
pnpm vitest run src/lib/__tests__/syndicateErrors.test.ts \
  src/stores/__tests__/syndicateStore.test.ts \
  src/components/session/__tests__/SyndicateTerminalPane.test.tsx \
  src/lib/__tests__/syndicateMachineStatus.test.ts

Test Files  4 passed (4)
     Tests  32 passed (32)
  Duration  8.64s
```

(Only noise: a stale-`caniuse-lite` Browserslist warning — unrelated.)

### Rust (`cd src-tauri && cargo test syndicate`) — PASS (19/19, on retry)

First run **failed to build** — not a test failure and not the WIP:

```
error[E0786]: found invalid metadata files for crate `packetbench_lib`
  note: failed to mmap file '...\packetbench-build\debug\deps\libpacketbench_lib.rlib':
        The paging file is too small for this operation to complete. (os error 1455)
error: could not compile `packetbench` (test "acp_stream") due to 1 previous error
```

OS error 1455 = Windows pagefile/memory exhaustion during the parallel link
(other Phase 0 workloads were running concurrently). Retry with
`cargo test syndicate -j 2` succeeded:

```
(lib test)      test result: ok. 19 passed; 0 failed; 681 filtered out
(main bin)      0 matching
(acp_stream)    0 matching (27 filtered out)
(api_schema)    0 matching (1 filtered out)
```

The 19 include the cross-language fixture check
(`commands::syndicate_relay::tests::cross_language_key_nonce_and_frame_fixture_match`)
and the endpoint-policy / relay-exchange / pairing-package suites.

WIP-related compiler noise observed (non-fatal, untouched per the rules):
ts-rs "failed to parse serde attribute" warnings, unused import
`UNIX_INSTALL_DIR` in `src/acp/install.rs:343`, dead const
`GROUP_TERM_GRACE` in `src/acp/mod.rs:1701`.

## Verdict summary

| Check | Verdict |
|---|---|
| A1 fixture parity | PASS |
| A2 production probes | PARTIAL — readyz 200 + WSS 101 PASS; healthz 404 (deployed revision predates alias; see caveat) |
| A3 packetrelay cargo test | PASS (61/61) |
| A4 syndicate host tests (copy) | PASS with caveat — 133/145 pass, 2 skipped; the 10 failures are one file's Windows-only `rmSync` EPERM teardown; the 3 plan-named suites pass 16/16 in isolation |
| A0 PacketBench vitest (4 files) | PASS (32/32) |
| A0 PacketBench cargo test syndicate | PASS (19/19) — first build attempt hit OS error 1455 (pagefile), clean on `-j 2` retry |

## Caveats

- Production `/healthz` returns 404 (see A2) — owner to confirm the deployed
  relay revision vs `src/main.rs:505` / `deploy.sh:83`.
- The PacketBench working tree carried unrelated uncommitted WIP throughout;
  no existing file was modified. New files were created only under
  `dev\syndicate-proof\`.
- Installer/plan drift recorded in `README.md` (plan said Syndicate v0.1.3;
  tree docs record v0.2.1 as live) — affects Phase 1, not Phase 0.
