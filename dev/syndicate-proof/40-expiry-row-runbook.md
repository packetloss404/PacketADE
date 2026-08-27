# Expiry Row Runbook — grant-liveness matrix (WSL2 host)

Execution order (from the 2026-08-16 plan): **1, 2, 7, 3, 4, 6a, 8, 9, 10,
11 last**; rows **5 / 5b / 6b are Method-B-gated** (signed grant cannot be
forged — packetrelay `syndicate_relay.rs:374-379`). After row 11: Method D
pairing check, then the day-29 / day-31 calendar checks.

> Provenance note: the full row bucketing was produced in the owner's
> plan-review session; this file reconstructs each row's steps from the
> verified code anchors. If a row label here disagrees with the umbrella
> list, the umbrella list wins — fix this file, don't improvise mid-run.

## Mechanics being proven

- **Host predicate** (`apps/host/src/controller-auth.ts:536`): any RPC from a
  device whose `grant_expires_at <= now` or whose status isn't `active` is
  rejected `401` — `DEVICE_REVOKED` when revoked, else `DEVICE_UNAUTHORIZED`.
- **30-day literal** (`controller-auth.ts:420`): grants are minted
  `now + 30d`; there is **no renewal path**, so every pairing reaches expiry.
- **PacketBench typed seam** (`src/lib/syndicateErrors.ts:84-89,:104`):
  `DEVICE_UNAUTHORIZED`/`GRANT_EXPIRED`/`DEVICE_EXPIRED` → grant status
  `expired`; `DEVICE_REVOKED` → `revoked`; Host `retryable:false` is the
  fatal verdict — no reconnect loop.
- **Card states** (`src/lib/syndicateMachineStatus.ts` —
  `SYNDICATE_GRANT_WARNING_DAYS = 7`, `Math.ceil` days-remaining):
  `unknown` (no relay grant to read) / `valid` / `expiring (≤7d)` / `expired`.
- **Banner** (`SyndicateTerminalPane.tsx:216-222`): attached-session surface
  for the fatal verdicts.

## Setup (once per session)

1. WSL host prepared via `10-wsl-host-setup.sh`; PacketBench paired (Method D
   below); a **local** `packet-relay.exe` serving the route — production is
   probe-only, never used here.
2. `20-method-a.sh backup` — never mutate without a fresh backup.
3. `20-method-a.sh show` — capture `sqlite-before.txt`.

Per row: evidence per `evidence-template.md` into `evidence/row-NN-<slug>/`.

## Rows (in execution order)

### Row 1 — Baseline: fresh grant, valid card
Freshly paired device (grant `now+30d`). **Expect:** card `valid`,
~30 days remaining; attach + RPC round-trip succeeds.

### Row 2 — Warning boundary: exactly +7d
`20-method-a.sh plus7d`. **Expect:** card flips to `expiring`,
`daysRemaining = 7` (boundary is `<= 7`); attach still succeeds — warning is
UI-only, the Host predicate still passes.

### Row 7 — Expired at connect
`20-method-a.sh expired`, then start a **new** attach. **Expect:** first RPC
rejected `401 DEVICE_UNAUTHORIZED`, `retryable:false`; PacketBench marks the
machine `expired`, banner shows the terminal verdict, **no reconnect loop**.
Capture the HAR error body + matching `correlationId` in the Host journal.

### Row 3 — Just outside the warning: +8d
`20-method-a.sh plus8d`. **Expect:** card back to `valid` (8 > 7), no
warning; attach succeeds.

### Row 4 — Deep in the warning: +3d
`20-method-a.sh plus3d`. **Expect:** card `expiring`, `daysRemaining = 3`;
attach succeeds.

### Row 6a — Host-side expiry mid-session
Attach with a valid grant, then `20-method-a.sh expired` **while attached**.
**Expect:** the session's next RPC fails `DEVICE_UNAUTHORIZED`
(`retryable:false`); banner flips to expired **without** a retry storm; card
persists `expired` into `packetbench:syndicate-machines-v1`.

### Row 8 — Rounding boundary: +6d20h
`20-method-a.sh plus6d20h`. **Expect:** `Math.ceil(6.83) = 7` →
card `expiring`, `daysRemaining = 7`. Proves ceil (a floor would say 6 /
possibly `valid` logic differences).

### Row 9 — Unknown expiry (SSH-only pairing)
Machine entry with no relay grant to read `expiresAt` from. **Expect:** card
state `unknown` — explicitly **not** `valid`; no fabricated warning or
expiry date.

### Row 10 — Revocation is not expiry
Revoke the device on the Host (Host UI/CLI, or
`UPDATE controller_devices SET status='revoked' ...` after a backup).
**Expect:** RPC fails `DEVICE_REVOKED` (not `DEVICE_UNAUTHORIZED`);
PacketBench grant status `revoked`, distinct card/banner copy, fatal.

### Row 11 — Restore and recover (LAST)
`20-method-a.sh restore <backup>`, restart `syndicate.service`, then re-pair
if the row's mutations invalidated the pairing. **Expect:** clean return to
Row-1 behaviour; capture the after-restore `show` output. Runs last because
it destroys the mutated state the other rows depend on.

## Method-B-gated rows (do NOT attempt locally)

- **Row 5 — relay rejects an expired signed grant at admission.**
- **Row 5b — relay-side expiry mid-session.**
- **Row 6b — end-to-end 30-day cliff (Host + relay agree).**

The relay verifies the Host's Ed25519 signature over the grant JSON; editing
`grant_expires_at` in the DB does not touch `relay_grant_json` /
`relay_grant_signature_base64url`, and a shortened grant cannot be re-signed
outside the Host. Blocked until Syndicate acts on `method-b-request.md`
(short-lifetime test grants). Mark these rows `SKIPPED (Method B pending)`
in evidence until then.

## Method D — fresh pairing check (after row 11)

1. Remove the device row (or use a pristine host), pair PacketBench from
   scratch via the pairing invitation flow.
2. **Expect:** `controller_devices` gains an `active` row with
   `grant_expires_at ≈ now + 30d` (the `:420` literal), matching signed
   `relay_grant_json`; card `valid` ~30d.

## Calendar checks — day 29 / day 31

With a real (unmutated) pairing from Method D, schedule two checks:

- **Day 29:** card must show `expiring, 1 day` (or 2, depending on hour —
  record the exact `Math.ceil` result); attach still works.
- **Day 31:** card `expired`; attach fails `DEVICE_UNAUTHORIZED`,
  `retryable:false`; re-pair is the only recovery (no renewal path).

These are the only rows that prove the literal against wall-clock time with
zero DB edits; put them in the calendar when Method D completes.
