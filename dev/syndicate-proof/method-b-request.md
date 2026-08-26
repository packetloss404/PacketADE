# Method B request — short-lifetime test grants

> **TO BE SENT BY THE OWNER to the Syndicate project.**
> This is a draft message only. It is **never applied to the Syndicate tree**
> by anyone working in this repo — the Syndicate checkout at
> `D:\projects\syndicate` is read-only.

---

Subject: Request: opt-in short-lifetime relay grants for expiry testing

Hi —

PacketADE is proving its handling of the 30-day controller relay grant
expiry (warning window, expiry cliff, typed `DEVICE_UNAUTHORIZED` /
`GRANT_EXPIRED` handling, no-retry-storm behaviour). We can drive the
**Host-side** predicate by editing `grant_expires_at` in our own state DB,
but three matrix rows need the **relay side** to see a genuinely short-lived
**signed** grant — and the grant signature (Ed25519 over the canonical grant
JSON, verified by the relay) rightly cannot be forged from outside the Host.

**Ask:** an opt-in, test-only way for the Host to mint grants with a short
lifetime.

Proposed shape (yours to change):

- Two env vars gate it, both required:
  - `SYNDICATE_UNSAFE_TEST_GRANTS=1` — master switch, default off.
  - `SYNDICATE_TEST_GRANT_LIFETIME_SECONDS=<n>` — the lifetime.
- Bounds: minimum ~300 s, maximum 30 d — the override can only **shorten**,
  never lengthen, the production lifetime.
- Implementation stays tiny: it only feeds the existing lifetime literal at
  the grant-mint site in `apps/host/src/controller-auth.ts` (~:420, the
  `now + 30 * 24 * 60 * 60 * 1_000` expression that flows into the atomic
  `UPDATE controller_devices ... grant_expires_at / relay_grant_json /
  relay_grant_signature_base64url` write at ~:425-426). **No schema change,
  no protocol change, no relay change** — the grant is signed as today, just
  with a nearer `expiresAt`.
- Safety visibility: a loud startup log line when the gate is active, and a
  marker field in `syndicate doctor --json` output, so a test-configured
  host can never be mistaken for a production one.

For our matrix a ~10-minute lifetime is ideal: it lets us watch the relay
reject an expired signed grant at admission, expire one mid-session, and
prove the full end-to-end cliff without waiting 30 days or touching state
out-of-band.

This is orthogonal to the device-refresh proposal (PR #6, merged — thank
you): that changes what happens *before* expiry; this only makes expiry
*reachable* in tests.

Happy to contribute the patch if you'd rather review than write it.

Thanks!
