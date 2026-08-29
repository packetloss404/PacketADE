# MCP hub

PacketBench sits on both sides of the Model Context Protocol. It **consumes**
MCP servers — the same `~/.claude/settings.json` and `.mcp.json` files the
Claude CLI reads — and hands them to agent sessions under a frozen trust
profile. It also **provides** an MCP server of its own, so Claude Code, Codex,
Cursor, or anything else that speaks Streamable HTTP can read PacketBench's live
state.

Everything lives in Settings → Integrations & Data → MCP.

![The MCP hub: curated catalog, configured servers with health and trust toggles, then the servers list and the provider card](../screenshots/PLACEHOLDER-mcp-hub.png)
*The MCP section stacks three cards: the Hub, the raw server list, and the provider.*

## Which agents actually use MCP

This is the first thing to get straight, because the picker offers nine agent
rows and only some of them can use an MCP server at all.

| Backend | Rows | MCP support |
| --- | --- | --- |
| Node sidecar | Claude Agent SDK (API), OpenAI Agents SDK (API) | **Full.** Server config forwarded, trust snapshot frozen at session start, per-tool enforcement at call time. |
| ACP (PacketCode engine) | PacketCode (ACP) | **Server-level only.** PacketBench chooses which servers the engine may use; the engine owns the MCP client, so per-tool allowlists and the denial floors cannot be enforced across that boundary. |
| In-process `LlmProvider` | Claude (API), OpenAI (API), MiniMax, OpenRouter, Ollama, Custom endpoint | **None.** These rows have no MCP client. |

> **Important:** Configuring an MCP server does nothing for a conversation
> running on an in-process provider row. If you want MCP tools in a
> conversation, start it on the Claude Agent SDK, OpenAI Agents SDK, or
> PacketCode row.

PTY terminal sessions (`claude`, `codex`, `opencode`, `packetcode` in a
Workspace pane) read the same config files themselves, directly. PacketBench
does not mediate that.

## Where server config lives

PacketBench reads and writes exactly two files, in the shapes the Claude CLI
already uses:

| Scope | File | Notes |
| --- | --- | --- |
| **Global** | `~/.claude/settings.json` | Under a `mcpServers` object. |
| **Project** | `<project>/.mcp.json` | Under a `mcpServers` object. Commit it, or don't — it's your repo. |

Global entries are listed first, then project entries, and **project overrides
global on a matching server name**. An entry with `"disabled": true` is listed
in the UI but dropped before it reaches a session.

Writes are careful:

- **Non-destructive upsert.** Only `command`, `args`, and `env` are replaced. A
  server's `type`, `url`, `headers`, `disabled`, and any custom fields survive
  intact, as do unrelated top-level keys in the file.
- **Atomic.** Temp file, fsync, rename — a crash or a full disk cannot truncate
  your config.
- **Fails closed on malformed JSON.** If the file will not parse, the write is
  refused with the parse error and the file is left byte-identical. Listing is
  more forgiving: an unparseable file reads as empty, with a warning in the log.

## Adding a server

### From the curated catalog

The Hub ships a small reviewed catalog. Each entry opens a **review sheet**
before anything is written, showing the official source URL, the exact command
and arguments that will be saved, which file will change, the capabilities it
claims, any required secrets, its network use, and how to remove it.

| Entry | Command | Required secrets |
| --- | --- | --- |
| **Filesystem** | `npx -y @modelcontextprotocol/server-filesystem <project path>` | none |
| **GitHub** | `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN -e GITHUB_READ_ONLY=1 -e GITHUB_LOCKDOWN_MODE=1 ghcr.io/github/github-mcp-server` | `GITHUB_PERSONAL_ACCESS_TOKEN` |

On Windows an `npx` command is materialised as `cmd /c npx …`. The
`$PROJECT_PATH` placeholder is substituted with the active project path, which
is how Filesystem gets scoped.

> **Note:** Installing from the catalog **runs nothing**. PacketBench writes the
> reviewed config entry and stops. The command is executed the first time a
> session (or a Diagnose) starts the server.
>
> Required secrets are named for review only. PacketBench never writes a
> placeholder value for them — an empty string would override the real value in
> your process environment and would misleadingly suggest PacketBench owns the
> secret. Supply them through the environment, or through the env pairs on a
> hand-written entry.

The catalog is validated at build time: HTTPS sources only, no duplicate ids, no
secret-shaped literals, no shell metacharacters in the command, no newlines in
arguments, and a mandatory network-use disclosure.

### By hand

**Add** on the MCP Servers card opens a form for a name, command,
space-separated arguments, `global`/`project` scope, and environment key/value
pairs. The name is immutable once created — editing an existing server changes
the command, args, env, and scope only.

HTTP and SSE servers are **not creatable from this form** — it writes a stdio
entry. Such entries can exist in your files (hand-written, or written by another
tool) and PacketBench preserves them; it just does not author them.

## Health checks

**Diagnose** on a configured server spawns it, performs the MCP handshake,
calls `tools/list`, and shuts it down, reporting one of:

| State | Meaning |
| --- | --- |
| `connected` | Handshake and `tools/list` succeeded. Latency and the tool list are shown. |
| `degraded` | The process started but the handshake or listing failed; the error text is shown. |
| `failed` | The process could not be spawned at all, or the entry's `type` is not a transport PacketBench recognises. |
| `notProbed` | Nothing was checked. Shown as **not probed**; the server's health is unknown, not bad. |

The compatibility version reported is `2024-11-05`.

> **Note:** The doctor probes **stdio only** — it spawns the process and speaks
> JSON-RPC over its pipes, and this build has no HTTP MCP client to probe with.
> An `http` or `sse` server therefore reports `notProbed`, **not** `degraded`.
> The distinction matters: `degraded` means "checked, and unhealthy", so using
> it for a server nothing was sent to made every healthy remote server look
> broken. `notProbed` says the health is unknown.

Diagnosing also seeds the default trust profile: tools whose names do not look
mutating are pre-granted, everything else is not.

## Trust profiles

Each configured server gets a trust profile, stored per `scope:name` and
persisted locally. Defaults for a newly seen server:

| Field | Default |
| --- | --- |
| Allow reads | **On** |
| Allow writes | **Off** |
| Network transport | On for stdio, off otherwise |
| Allowed roots | The active project path |
| Allowed tool names | Every diagnosed tool that does not look mutating |
| Denial floors | `credentials`, `outside_workspace`, `protected_publish` — always, not editable |

The Hub exposes Read, Write, and Network-transport checkboxes, a root list, and
a per-tool grant chip for every tool the diagnostic found. Turning Read off also
turns Write off; turning Write on turns Read on.

Every change is written to a local, bounded trust audit visible in "Recent Hub
activity" and in Settings → Security & Diagnostics → Trust & Provenance.

### When a change takes effect

Trust is **frozen at session start**. A snapshot of the profiles for the servers
that conversation is allowed to use is captured when the session begins and sent
with it, so later edits in Settings can never silently broaden a running
session's authority. This is what sidecar protocol **v11** added.

To apply a change to a live conversation, use **Reconnect selected** at the top
of the Hub. It closes the selected API conversation's backend safely; its next
user turn reconnects with the current snapshot. (The button is only enabled for
an API-mode conversation.)

### What the sidecar enforces

For sidecar-backed sessions, enforcement happens at tool-call time and is an
**allowlist, not a denylist**. A read-only session runs a tool only when the
server annotated it `readOnlyHint: true` or you explicitly granted it. Anything
the session has never heard of is denied — unknown is not read-only.

A verb denylist survives beneath that as an extra floor, catching unambiguously
mutating names (write, create, delete, patch, commit, chmod, put, exec, …) both
as substrings and as tokenised parts of `read_file` / `readFile` / `read-file`
style names.

Credential access, work outside the workspace roots, and protected publish
operations are blocked regardless of any toggle.

> **Warning:** For a **PacketCode (ACP)** session only the server-level half of
> the snapshot is enforceable. The engine owns the MCP client and dispatches
> every tool call, so per-tool allowlists, `readOnlyHint` probes, root checks,
> and the denial floors do not cross that boundary. Grant servers to an ACP
> session on the understanding that you are trusting the whole server.

## Which servers a conversation starts with

The MCP Servers card has an **"On for agent sessions"** checkbox per server.
This is a project-level default for **newly started** agent conversations; a
conversation already running keeps whatever it froze. **Reset to all** returns
it to the default of "every non-disabled server".

Explicit per-conversation values — from an agent profile, or inherited by `/new`
— override this default.

## MCP on a remote (SSH) workspace

When a session runs on a remote host, the sidecar runs *there*, and it sources
its own MCP config from the **remote** filesystem
(`~/.claude/settings.json` + `<remote project>/.mcp.json`, project over global).
PacketBench forwards an empty server map plus a "source MCP from the filesystem"
directive.

That is deliberate and has three consequences:

- No local command, argument, environment value, or secret ever crosses SSH.
- Stdio commands resolve against the **remote** `PATH`, which is the only place
  they could work.
- A remote project's own `.mcp.json` is honoured.

So the servers you see in the Hub are the *local* ones. To change what a remote
session gets, edit the config files on that host.

## PacketBench as an MCP provider

The **MCP Provider** card starts a local server that exposes PacketBench's own
state to external MCP clients.

Enable it and you get a URL and a bearer token to paste into the other client's
config:

```json
{
  "mcpServers": {
    "packetbench": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp",
      "headers": { "Authorization": "Bearer <token shown in the card>" }
    }
  }
}
```

- **Transport:** Streamable HTTP via the `rmcp` crate, mounted at `/mcp`. (The
  deprecated 2024 HTTP+SSE transport is not used.)
- **Port:** default 3100, editable while stopped. Setting `0` lets the OS pick;
  the card shows the port actually bound.
- **Token:** a fresh 128-bit token is minted on every start. Restarting the
  server invalidates the old one.

### Security posture

Four independent layers, because this is a localhost service:

1. Binds `127.0.0.1` only — never `0.0.0.0`, so nothing on the LAN can reach it.
2. Host allowlist (`127.0.0.1:<port>`, `localhost:<port>`) as a DNS-rebinding
   guard.
3. Any *present* non-loopback `Origin` header is rejected, so a browser page
   cannot reach it even if it resolves a name to 127.0.0.1. An absent Origin is
   allowed, because CLI clients omit it.
4. The bearer token is the actual access control — other local processes cannot
   call in without it.

### What it exposes

**Resources** (`packetbench://…`, all JSON):

`project`, `flights`, `flights/<id>`, `flights/<id>/inbox`, `issues`,
`memory/patterns`, `memory/project/<workspaceId>`, `workspaces`, `reviews`, and
`packetcode/health`.

**Tools:**

| Tool | Needs writes? |
| --- | --- |
| `ping`, `get_active_flight`, `list_runnable_tasks`, `read_task_details`, `list_workspaces` | No |
| `read_memory_context`, `search_project_memory`, `read_project_memory` | No |
| `read_coordination_inbox` | No |
| `create_project_memory`, `update_project_memory`, `archive_project_memory` | **Yes** |
| `append_handoff`, `escalate`, `post_coordination_message`, `acknowledge_coordination_message` | **Yes** |

**Allow writes** is off by default and can only be changed while the server is
stopped. With it off the provider is strictly read-only. With it on, the writes
are append-only coordination notes and confined project-memory notes — nothing
can launch a Flight, start a session, or change settings through this surface.

### Activity log

While running, the card streams every tool call and resource read as it happens
— kind, name, timestamp — from a bounded in-memory ring (200 entries in the
backend, 50 shown). It is **not persisted**: stopping the server empties it.

> **Note:** The provider's persisted config carries `allowedTools` and a `scope`
> field that are **not used**. Only the port and the allow-writes flag are sent
> to the backend, and the card does not surface the other two. Every tool in the
> table above is available to an authenticated client, subject only to the
> allow-writes gate.

## Related

- [Agents & conversations](agents.html) — which row to pick, and the header menu that shows a conversation's MCP sources.
- [SSH remote workspaces](remote.html) — why remote MCP config is sourced remotely.
- [Agent event contract](dev-agent-contract.html) — the `mcp-sources` event and sidecar protocol v11.
- [Settings reference](settings.html) — the MCP section in context.
