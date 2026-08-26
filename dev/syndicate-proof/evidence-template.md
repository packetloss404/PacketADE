# Evidence — Row __ : ____________________

> Copy this file into `evidence/row-NN-<slug>/evidence.md` for each executed
> row and fill every section. An empty section means the row is not proven.

## Row metadata

- **Row / variant:** (e.g. `Row 3 — grant_expires_at = now+8d`)
- **Method:** A (state-DB edit) / B (short-lifetime signed grant) / D (fresh pairing)
- **Date / time (UTC):**
- **Host:** WSL Ubuntu-26.04 / Hyper-V VM (name, image)
- **Syndicate version:** (`syndicate doctor --json` → version field)
- **PacketADE build:** (commit / installer version)
- **Relay:** local `packet-relay.exe` (commit) — production is never used for
  stateful rows.

## Expected vs observed

- **Expected:** (one sentence from `40-expiry-row-runbook.md`)
- **Observed:** (one sentence; PASS / FAIL verdict)

## Artifacts (attach all)

1. **Banner / card screenshots** — the Syndicate machine card and, where the
   row involves an attached session, the `SyndicateTerminalPane` banner.
   State shown must match the expected `SyndicateGrantExpiry` state
   (`valid` / `expiring (N days)` / `expired` / `unknown`) or grant status
   (`revoked` / `expired`).
   - `card-before.png`, `card-after.png`, `banner.png` (as applicable)
2. **HAR filtered to `session.attach`** — export from the PacketADE webview
   devtools, filtered to the attach RPC(s) for this row. Include the error
   body when the row expects a typed failure
   (`DEVICE_UNAUTHORIZED` / `DEVICE_REVOKED` / `GRANT_EXPIRED`, plus
   `retryable: false`).
   - `session-attach.har`
3. **`packetade:syndicate-machines-v1` dump** — from the webview console:
   `copy(localStorage.getItem('packetade:syndicate-machines-v1'))`, saved as
   `syndicate-machines-v1.json`. Must show the machine's persisted
   `grantExpiresAt` / status the UI rendered from.
4. **Host journal excerpt with correlationId** —
   `journalctl --user -u syndicate.service --since "<row start>" -o short-iso`
   trimmed to the request(s) for this row; the `correlationId` in the journal
   must match the one in the HAR error body.
   - `journal.txt`
5. **sqlite before/after SELECTs** — from `20-method-a.sh show` (or manual):

   ```sql
   SELECT id, status, grant_expires_at,
          substr(relay_grant_json, 1, 120) AS grant_head
   FROM controller_devices;
   ```

   captured **before** and **after** the row's mutation (and after restore,
   for the restore step).
   - `sqlite-before.txt`, `sqlite-after.txt`
6. **DB backup path** — the timestamped backup `20-method-a.sh backup`
   created before mutating (proves restorability).

## Caveats / anomalies

(anything off-script: retries, clock skew, extra reconnects, warnings)
