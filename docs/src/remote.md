# SSH remote workspaces

A PacketBench workspace can be bound to a remote host instead of a local folder.
Terminal panes open a real SSH session on that host, API-agent tool calls
(read, write, list, bash, grep) run there, and Flight attempts can provision
worktrees there. Nothing is mirrored or synced — the code lives on the remote
machine and PacketBench drives it over `ssh`.

Everything goes through the system `ssh` binary. There is no bundled SSH
implementation, so your existing agent, keys, and config apply.

![The Remote Hosts settings card listing configured servers with their auth method](../screenshots/PLACEHOLDER-remote-hosts.png)
*Settings → Workspaces & Terminal → Remote Hosts is the only place hosts are managed.*

## The host record

One record type covers everything: `ServerConfig`. It powers workspace terminal
panes, agent file/bash tools, and remote worktree attempts alike.

| Field | Notes |
| --- | --- |
| Name | Display label, used in memory scope chips and Flight target pickers. |
| Host | Hostname or IP. |
| Port | Default 22. |
| Username | Remote user. |
| Auth method | `agent`, `key`, or `password`. |
| Key path | Only for `key`. Validated against control and shell-special characters before it can reach argv. |
| Remote path | Default project directory offered when creating a workspace on this host. |
| Host fingerprint | SHA-256 host key captured at pinning time. |

Add or edit a host in **Settings → Workspaces & Terminal → Remote Hosts**. That
card is the only reachable host manager.

### Passwords

A password for `password` auth is stored in the **OS credential store** under
the account `ssh-<server id>`, never in app state, never in a workspace record,
and never in an ordinary file. The form only shows whether one is stored, and it
is never read back into the UI.

On Unix, OpenSSH refuses to read a password from stdin — it wants a TTY or an
askpass program. PacketBench writes the keyring password to a random file with
mode 0600 inside a mode-0700 temporary directory, re-invokes its own executable
as `SSH_ASKPASS`, and deletes both file and directory when the connection guard
drops. The secret never appears in argv or in an environment value.

> **Tip:** Prefer `agent` or `key` auth. Password auth works, but it means a
> credential PacketBench has to hand to `ssh` on every connection, and it cannot
> use SSH's connection multiplexing as effectively.

### Deleting a host

Deleting shows what is currently riding on it — live connections, conversations,
Flights, workspaces — before you confirm. The record and its stored SSH password
are removed; **nothing on the remote machine is touched**. Both the current and
the legacy keyring entries are cleared, so a reused id cannot resurrect an old
password.

## Host-key pinning

Saving a host requires verifying its key first. **Verify** runs `ssh-keyscan`
against `host:port`, shows every key it returns with its SHA-256 fingerprint,
and **Trust** writes the chosen key into an app-managed `known_hosts` file at:

```text
~/.packetbench/ssh/known_hosts
```

On Unix that directory is created with mode 0700.

Once a fingerprint is pinned, every SSH invocation adds:

```text
-o StrictHostKeyChecking=yes
-o UserKnownHostsFile=<app known_hosts>
```

Changing the host field invalidates the pin, so you must re-verify — the save
button stays disabled until you do.

> **Warning:** Records saved before pinning existed have no fingerprint. Those
> fall back to TOFU (`StrictHostKeyChecking=accept-new`) for compatibility, with
> a warning logged on the Rust side and in the browser console. That is a silent
> MITM window. Open the host in Settings and press Verify to close it.
>
> **Async Flight launches refuse to run unpinned.** Interactive use tolerates
> TOFU because a person is watching; a non-interactive fan-out is not, so
> launching an SSH attempt against an unpinned host fails closed before any
> connection or worktree provisioning is attempted: *"Refusing to launch against
> &lt;host&gt;: host key not verified. Pin it on the Servers page first."*

## Testing a host

**Test connection** in the host form authenticates and checks the configured
remote path in one round trip. It reports whether the path exists, whether it is
a directory, and whether it is a Git repository. A path that authenticates but
is not a directory is reported as a failure, because that is not a usable
workspace root.

The test is invalidated whenever you change the host, port, auth, or key, so a
green result always refers to the configuration currently in the form.

## Creating a remote workspace

In the workspace creation modal, switch the location from **Local** to
**Remote** and pick a host. The remote path pre-fills from the host's default
and is live-validated as you type (debounced).

If the path is empty, the modal can offer to **clone a repository into it**
first, then create the workspace.

Remote workspaces store `serverId` and `remoteProjectPath`, and an execution
target of `{ kind: "ssh", serverId }`.

> **Note:** `layoutStore.projectPath` is a **local-only mirror**. When a remote
> workspace is active it deliberately keeps the last *local* project path, so
> local-filesystem features (git pollers, the file watcher, MCP config, deploy)
> are never handed a remote path. Anything that must be correct for a remote
> workspace reads the workspace record, not the mirror — this is exactly what
> [Memory](memory.html) had to be fixed to do.

## What runs remotely

### Terminal panes

A pane on a remote workspace launches `ssh` rather than the CLI directly. The
command is composed as:

- `-o ConnectTimeout=10`, plus the pinning or TOFU flags above
- `-t` to allocate a pseudo-terminal
- `-p <port>` when it is not 22
- auth-method-specific preferences: `PreferredAuthentications=publickey` for
  agent and key (with `-i <keyPath>` for key), and
  `keyboard-interactive,password` with `PubkeyAuthentication=no` for password
- `user@host`, then a remote command

The remote command `cd`s into the project path, augments `PATH` with the usual
user-local bin directories (`~/.local/bin`, `~/.npm-global/bin`, `~/.cargo/bin`,
`~/.opencode/bin`, the newest nvm node, `/usr/local/bin`), exports any
per-pane environment (multi-account `CLAUDE_CONFIG_DIR` / `CODEX_HOME`), and
execs the CLI — or a login shell for a plain terminal pane. Every component is
shell-escaped, and environment variable *names* are validated against
`^[A-Za-z_][A-Za-z0-9_]*$` before they can be emitted.

`ssh` is on the PTY command allowlist alongside `claude`, `codex`, `opencode`,
`packetcode`, and the shells. For an SSH session the local working directory is
set to your home directory rather than validated as a project path, because the
project path is not local.

Remote terminals use the host's **login shell**. The local terminal-shell
selection in Settings → Workspace defaults does not apply, and its workspace
override is disabled for a remote workspace.

### API-agent tool calls

An API conversation started on a remote workspace carries an `SshConfig` built
from the host record at the call site. Its file and bash tools then execute over
`ssh`.

Path safety is enforced in Rust before anything reaches the remote shell:

- Absolute paths are rejected — every tool path must be relative to the
  configured workspace.
- `..` components are rejected.
- NUL bytes are rejected.
- Everything is POSIX single-quote escaped.

Connection performance differs by platform. On Unix, PacketBench uses SSH
connection multiplexing (`ControlMaster=auto` with a per-host socket under
`~/.packetbench/ssh-cm/`, mode 0700, `ControlPersist=60`), so the first tool
call pays the handshake and the rest are near-instant. **Windows OpenSSH has no
ControlMaster** — it needs Unix domain sockets — so on Windows PacketBench only
sets `ServerAliveInterval=30` and every call pays a full handshake.

> **Important:** Always let the host record carry a pinned fingerprint. The
> `SshConfig` handed to the tool runtime takes `host_fingerprint` from
> `ServerConfig.hostFingerprint`; when it is absent the Rust side falls back to
> TOFU and logs a warning.

### MCP

Remote sessions source their MCP config from the **remote** filesystem
(`~/.claude/settings.json` plus the remote project's `.mcp.json`), not from
yours. No local command, argument, environment value, or secret crosses SSH.
See [MCP hub](mcp.html#mcp-on-a-remote-ssh-workspace).

### Flight attempts

`LaunchAsyncFlightModal` can target one or more SSH hosts. Each attempt gets its
own worktree on the remote host, and cleanup can be re-issued with live host
credentials if the first attempt at it fails.

Two rules apply specifically to remote fan-outs:

- Every SSH target must be pinned, checked before provisioning (above).
- A memory brief is only injected when every target agrees on one scope. A
  mixed local/SSH fan-out, a fan-out spanning two servers, or one spanning two
  base paths carries the raw prompt instead — PacketBench will not guess which
  project's memory the launch is entitled to.

### Memory

Sessions, Flights, and saved notes on a remote workspace are recorded against
that server and injected back into its agents. Scope keys are
`ssh:<serverId>:<remote path>` and never match across servers or across local
and remote. `.agents/memory` project notes remain local-only, because they are
read off this machine's filesystem. See [Memory](memory.html#scope-which-project-memory-belongs-to).

## What does not work remotely

These are gated off deliberately, not broken:

| Surface | Behaviour on a remote workspace |
| --- | --- |
| The built-in file editor / editor dock panel | **Disabled**, with the tooltip "Not yet available for SSH workspaces". |
| Agent inspector file panels | Same. |
| Memory → Project notes tab | Shows an explanation that `.agents/memory` is read from this machine. Everything else in Memory does work for the workspace. |
| Code Quality | Remote-aware gating; the analysis runs against a local path. |
| Terminal shell override | Disabled — the host's login shell is used. |
| Toolbar "open folder" | Disabled. |
| Flight target picker (local list) | Only local workspaces with a project path appear there; SSH targets are chosen as hosts. |

The Git dashboard **does** work: it is given the remote project path and the
server id.

## Troubleshooting

**"Command 'x' is not allowed."** The PTY allowlist covers `claude`, `codex`,
`opencode`, `packetcode`, `ssh`, and the shells. A remote workspace always
launches `ssh`, so this usually means a local pane is trying to launch something
unlisted.

**A remote CLI is "not found" even though it is installed.** The remote command
is not run through a login shell, so a `PATH` set in `~/.bash_profile` may not
apply. PacketBench prepends the common user-local bin directories listed above.
If your CLI lives somewhere else, add it to a file that a non-login shell reads,
or pin an absolute path.

**Every tool call is slow on Windows.** Expected — no connection multiplexing.
Each call is a fresh SSH handshake.

**"host key not verified" when launching a Flight.** Open the host in Settings →
Remote Hosts, press Verify, trust the key, and save.

**The memory pane looks like the wrong project.** Check the scope chip in the
Memory header. It should read `<server> · <folder>` with a server icon for a
remote workspace.

## Related

- [Workspaces & terminals](workspaces.html) — panes, layouts, and shells.
- [Flight Deck](flights.html) — launching worktree attempts across targets.
- [MCP hub](mcp.html) — why remote MCP config is sourced remotely.
- [Memory](memory.html) — remote scoping and the adoption migration.
- [Settings reference](settings.html) — the Remote Hosts card in context.
