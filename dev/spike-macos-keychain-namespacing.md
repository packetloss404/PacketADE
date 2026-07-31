# SPIKE — Does Claude Code namespace its macOS Keychain item per `CLAUDE_CONFIG_DIR`?

Status: **OPEN — needs a real Mac.** Filed 2026-07-31 alongside the multi-account
CLI feature (`4d3df4f`).

## Why this matters

The multi-account CLI feature gives each `CliAccount` its own `configDir` and
injects `CLAUDE_CONFIG_DIR` into that pane's PTY environment. On Linux and
Windows, Claude Code writes `.credentials.json` inside that directory, so two
accounts are cleanly isolated.

On macOS, Claude Code stores credentials in the **login Keychain** instead. If
the Keychain item name is fixed, two config dirs collide: logging in to account B
overwrites account A's entry, A then refreshes with B's token, and A starts
401ing. That would make the feature quietly wrong on macOS — the worst outcome,
since the whole point is keeping client work off the wrong account.

## The disagreement

**Evidence it IS namespaced** (from reading the shipped `claude` 2.1.220 bundle):
the secure-storage item name is computed roughly as

```js
const isDefaultNamespace = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined
  ? !process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  : !process.env.CLAUDE_CONFIG_DIR;
const suffix = isDefaultNamespace
  ? ""
  : `-${sha256(effectiveConfigDir).slice(0, 8)}`;
return `Claude Code${suffix}`;
```

i.e. a non-default `CLAUDE_CONFIG_DIR` yields a distinct item name, and
`CLAUDE_SECURESTORAGE_CONFIG_DIR` exists as an explicit override to decouple the
credential namespace from the config dir.

**Evidence it is NOT namespaced:** [anthropics/claude-code#20553](https://github.com/anthropics/claude-code/issues/20553)
reports a single fixed `Claude Code-credentials` item (service `Claude Code-credentials`,
account `$USER`), with profile B's login clobbering profile A's entry.

Most likely the issue predates the namespacing fix. Unconfirmed either way from
Linux — the code path is macOS-only.

**Codex is not affected.** Its keyring key is source-confirmed in
`codex-rs/login/src/auth/storage.rs` as service `"Codex Auth"` with key
`cli|<sha256(canonical(CODEX_HOME))[..16]>`, so two `CODEX_HOME` values already
yield two distinct entries.

## Procedure

Run on a real Mac with a current `claude` install. Steps 1–4 answer the primary
question; step 5 answers the refresh-safety follow-up.

```bash
# 0. Baseline: what exists before we start
security dump-keychain 2>/dev/null | grep -i "Claude Code" | sort -u

# 1. Log in under the DEFAULT config dir (this is your normal account)
claude          # complete /login if not already authenticated
security dump-keychain 2>/dev/null | grep -i "Claude Code" | sort -u

# 2. Log in under a SECOND config dir, as a different account
export CLAUDE_CONFIG_DIR=~/.claude-spike
claude          # complete /login with the SECOND account
security dump-keychain 2>/dev/null | grep -i "Claude Code" | sort -u

# 3. THE ANSWER
#    Two distinct "Claude Code…" items  -> NAMESPACED. Feature is safe on macOS.
#    Still one item                     -> COLLIDES. See fallback below.

# 4. Confirm the default account still works, in a clean shell
env -u CLAUDE_CONFIG_DIR claude -p "say ok"

# 5. Refresh safety: leave both alive past an access-token expiry, then use each
#    again and confirm neither 401s and neither silently becomes the other
#    account. (Check the account identity the CLI reports, not just success.)
```

Also worth capturing while you are there: whether `~/.claude-spike/.credentials.json`
exists at all on macOS, or whether the config dir holds only non-credential state.

## Cleanup

```bash
rm -rf ~/.claude-spike
# and delete the spike's Keychain item via Keychain Access, if one was created
```

## What we do with each outcome

**Namespaced (expected).** No code change. Delete the `unknown` auth-status
caveat path for macOS in `get_provider_auth_status_for_dir` — or better, keep the
status but teach the probe to read the namespaced Keychain item so macOS gets a
real ready/login_required answer instead of "may be signed in".

**Collides.** macOS needs a different isolation mechanism per account. The
candidate is `CLAUDE_CODE_OAUTH_TOKEN` (obtained via `claude setup-token`, valid
~1 year on Pro/Max/Team/Enterprise), which takes precedence over Keychain
credentials and is a per-process pin. Caveat to verify first:
[anthropics/claude-code#37512](https://github.com/anthropics/claude-code/issues/37512)
reports it deleting the Keychain entry on exit (closed as not planned). If that
reproduces, storing the token per-account in our own keyring and injecting it as
env is viable, but it must not destroy the ambient login as a side effect.
Linux and Windows keep using `CLAUDE_CONFIG_DIR` either way.

## Current behaviour until this is answered

`get_provider_auth_status_for_dir` returns a dedicated `unknown` status for
`claude-oauth` on macOS when the account's config dir contains no credential
file. `unknown` means *"may well be signed in; do not treat as a negative"* — the
launch gate lets it through with the account env still injected, and surfaces the
caveat on the pane's account chip tooltip. It never falls back to the ambient
login. That is deliberately the conservative-but-usable choice: we do not block a
launch on an unverifiable signal, and we never silently run under the wrong
account.
