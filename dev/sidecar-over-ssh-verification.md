# Sidecar-over-SSH Verification

Read-only verification plan for the Remote Workspace Completeness track. This
document is scoped to Sidecar-over-SSH provider parity: the API-key-backed
Claude Agent SDK and OpenAI Agents SDK rows must run provider work on the SSH
host, while the desktop keeps the same `api-agent:*` event contract.

## Current Behavior

PacketADE now lets workspace conversation tiles select SSH targets for
sidecar-backed providers. On the backend, `start_api_agent_session` routes sidecar providers
with `ssh_config` through a dedicated SSH sidecar process instead of the
app-wide local sidecar.

The local sidecar still refuses `workspace.kind === "ssh"` as a safety net. If
remote metadata reaches the local sidecar, that is a routing bug.

## Target Contract

For a remote sidecar session, the desktop supervisor should spawn:

```bash
ssh <ssh-options> <user>@<host> "cd \"$PROJECT_PATH\" && exec \"$NODE_BIN\" \"$SIDECAR_ENTRY\""
```

Then it should wire stdin/stdout to the same newline-delimited sidecar protocol
used by the local sidecar. Defaults:

- `NODE_BIN`: remote `node` on PATH, or desktop
  `PACKETADE_REMOTE_NODE_PATH` injected into the launch script.
- `SIDECAR_ENTRY`: remote `~/.packetade/agent-sidecar/dist/index.js`, or
  desktop `PACKETADE_REMOTE_SIDECAR_PATH` injected into the launch script.
- `PROJECT_PATH`: the configured SSH workspace path.

## Targeted Automated Checks

Run these while iterating on the remote sidecar transport:

```bash
pnpm sidecar:install
pnpm sidecar:build
pnpm sidecar:remote-project-smoke
pnpm exec vitest run src/components/agents/__tests__/ProjectPickerRemoteSupport.test.tsx src/stores/__tests__/agentWorkspaceDecoupling.test.ts
cargo test --manifest-path src-tauri/Cargo.toml remote_
```

The 2026-07-19 parity pass also fixed password-auth path probing: the frontend
now sends the canonical server id and Rust loads the saved credential from the
OS keyring when no transient password is present. Passwords never round-trip to
the webview for this probe.

Run these before handing off a release-confidence build:

```bash
pnpm sidecar:check
pnpm test
pnpm rust:check
pnpm rust:test
pnpm preflight
```

For full local confidence, follow [`dev/local-quality-gates.md`](./local-quality-gates.md):

```bash
pnpm check
```

## Manual SSH Parity Checklist

Use one Unix SSH host with a pinned host key and a real git checkout.

1. Configure the host in the Servers UI and confirm the host fingerprint is
   pinned.
2. Confirm the remote project path exists and is a git worktree.
3. Copy or build the sidecar on the remote host at
   `~/.packetade/agent-sidecar/dist/index.js`, or start PacketADE with
   `PACKETADE_REMOTE_SIDECAR_PATH` pointing at the remote entry path.
4. Confirm `node` is on the remote PATH, or start PacketADE with
   `PACKETADE_REMOTE_NODE_PATH` set to the remote Node binary path.
5. Start a conversation tile in a remote workspace with **Claude Agent SDK (API)**
   against the SSH project.
6. Verify the local sidecar safety-net error does not appear:
   "Remote SSH workspace metadata reached the local sidecar".
7. Verify streamed `api-agent:chunk`, `api-agent:thinking`,
   `api-agent:permission-request`, `api-agent:pending-edit`, `api-agent:done`,
   and `api-agent:error` events still render in the existing chat UI.
8. Ask for a safe read-only operation and confirm results come from the remote
   checkout.
9. Ask for a small edit, approve it, and confirm the changed file exists on the
   remote host, not in the desktop checkout.
10. Cancel a running turn and confirm the remote sidecar exits or returns to an
    idle state without leaving the session stuck active.
11. Resume the same conversation and confirm the stored remote server id,
    remote path, port, key path, and host fingerprint are used.
12. Repeat the smoke with **OpenAI Agents SDK (API)**. It shares the same
    provider-agnostic remote-sidecar route but receives its API key transiently
    from PacketADE's keyring. Confirm a multi-turn conversation, permission
    request, pending edit, cancellation, and resume all stay bound to the remote
    project. The retired `api-openai-codex` / `codex exec` chat provider is not
    part of this matrix; Codex CLI remains available separately as a PTY-backed
    Workspace session.

Current verification state (2026-08-01): automated route, remote-project,
protocol, ordering, and MCP trust checks pass. The live provider matrix remains
pending because this development profile contains no configured SSH server; it
requires a real pinned Unix host with the installed sidecar and the relevant
API keys configured in PacketADE.

## Failure Modes To Watch

- Local checkout changes after a remote sidecar run. This means the supervisor
  launched the local sidecar by mistake.
- `projectPath` validation errors for POSIX remote paths on Windows desktops.
- SSH sessions without pinned host keys unless the server is a legacy
  TOFU-fallback entry.
- Password-auth hosts hanging or swallowing the first JSON request because the
  password and sidecar stdin share one SSH stream.
- Permission/edit prompts reaching the sidecar but not returning to the
  existing `api-agent:*` UI event channels.
- `close_session` or `cancel` only touching the local sidecar manager while the
  remote process keeps running.

## 2026-08-01 proof refresh

`pnpm sidecar:check` passes the remote-project, protocol, ordering, MCP trust,
and remote-MCP-from-filesystem smokes; the focused remote picker and Workspace
decoupling tests pass too. PacketADE still has zero configured SSH servers, and
the remote Node/sidecar overrides are absent. The live provider matrix therefore
remains a real environment gate rather than an automated claim. See
[`proof-audit-2026-08-01.md`](./proof-audit-2026-08-01.md).
