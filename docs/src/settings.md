# Settings reference

Every control in PacketBench's Settings view, what it defaults to, what it
actually changes, and when the change takes effect. Settings is reached from the
left navigation; deep links from elsewhere in the app (a "Fix this in Settings"
button, for example) open the matching section directly.

## How Settings is organised

![The Settings view: the six-group rail with its search box on the left, section chips under the group heading, and scope pills beside the active section](../screenshots/PLACEHOLDER-settings-shell.png)
*Groups on the left, sections as chips, scope pills on the right of the section heading.*

The left rail lists **six groups**. Selecting a group opens its first section;
sections appear as chips under the group heading. A search box above the rail
matches group and section labels, descriptions, and a keyword list — searching
`fingerprint` finds Remote Hosts, `push to talk` finds Dictation.

| Group | Sections |
| --- | --- |
| **General** | Preferences · Date & Time |
| **Workspaces & Terminal** | Workspace defaults · CLI Clients · CLI Accounts · Remote Hosts · Project Rules |
| **Agents & Models** | Agent behavior · Providers & Models |
| **Automation** | Flights & Autonomy · Task Role Defaults · PacketAgent |
| **Integrations & Data** | Git Hosts · MCP · Issues · Memory · Dictation · Modules |
| **Security & Diagnostics** | Trust & Diagnostics |

### Scope pills

Each section shows one or more scope pills next to its heading. They are a
promise about *reach*, and this page uses the same vocabulary:

| Pill | Meaning |
| --- | --- |
| **App** | One value for the whole installation. Takes effect immediately. |
| **Project** | Belongs to the currently open project — usually stored in the project's own files. |
| **Workspace** | Belongs to the active workspace; other workspaces are unaffected. |
| **New sessions** | Read when a terminal/PTY session starts. Running sessions keep what they started with. |
| **New conversations** | Read when an agent conversation starts. Running conversations keep what they froze. |
| **New Flights** | Read when a Flight is created or launched. Existing Flights keep their policy snapshot. |

> **Note:** Most settings persist to `localStorage` under `packetbench:*` keys.
> Secrets never do — API keys, git-host tokens, SSH passwords, and the
> PacketAgent token all live in the OS credential store. Flight autonomy and
> commit-trailer settings persist through the Rust state file.

---

## General

App-wide appearance, notifications, and keyboard behaviour.

### Preferences

*Scope: App.* Three cards side by side.

#### Theme

| Control | Default | Effect |
| --- | --- | --- |
| Dark / Light | **Dark** | Switches the whole app's theme tokens immediately. |

#### Notifications

Desktop notifications. Turning the master switch on requests OS permission
first; if permission is refused the switch stays off. The event toggles only
appear while notifications are enabled.

| Control | Default | Effect |
| --- | --- | --- |
| Enable notifications | On | Master switch. |
| Only when app unfocused | On | Suppresses notifications while PacketBench has focus. |
| Approval needed | On | Fires when an agent is waiting on you. |
| Session complete | On | Fires when a session finishes. |
| Session error | On | Fires when a session fails to start or dies. |
| Cost threshold alerts | On | Fires when a budget guardrail warning threshold is crossed. |

#### Keyboard Shortcuts

This card owns the **global dictation** accelerators; everything else in
PacketBench's shortcut set is in-app and not editable here.

| Control | Default | Effect |
| --- | --- | --- |
| Global dictation shortcuts | **Off** | Explicit opt-in. Registers the three accelerators with the OS. In-app controls and Escape work regardless. |
| Push to Talk (hold) | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Space</kbd> (<kbd>Cmd</kbd> on macOS) | Hold to record, release to transcribe. Re-bindable; must include a modifier. |
| Toggle Recording | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> | Start/stop. Re-bindable; must include a modifier. |
| Cancel Recording | <kbd>Escape</kbd> | Fixed, in-app only. |
| Open Dictation | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> | Fixed. |

Press the pencil to re-capture a binding; the row swallows keystrokes until you
press a valid combination, and Escape cancels. A rotate icon appears when a
binding differs from its default. All three accelerators must be distinct, and
PacketBench only unregisters what it successfully registered — an existing OS or
app binding is reported as a conflict, never seized. The status line under the
rows reads *off*, *registering*, *active*, or the conflict message.

### Date & Time

*Scope: App.*

| Control | Default | Effect |
| --- | --- | --- |
| Time zone | **System default** | The zone every date and time in PacketBench is rendered in. Stored as an IANA zone name, so daylight saving is applied per timestamp rather than as a fixed offset. |

A zone saved by an older IANA release that this system no longer recognises
stays selectable and is called out in amber; dates fall back to the host zone
until you pick a valid one.

> **Warning:** Dictation analytics — streaks, hourly activity, and the daily and
> weekly totals — are bucketed by **UTC** days in the backend and do **not**
> follow this setting. Away from UTC they can disagree with timestamps shown
> elsewhere for entries near midnight. See [Dictation & analytics](dictation.html#analytics).

---

## Workspaces & Terminal

### Workspace defaults

*Scope: App, Workspace.* Three cards.

#### Project

| Control | Default | Effect |
| --- | --- | --- |
| Path · Browse | — | Rebinds the **active workspace's** project folder. To change another workspace's path, switch to it first. |
| Projects Folder · Browse / Clear | Not set | A parent folder whose subdirectories are listed in the sidebar's projects list. |

With no workspace open, the card shows the last-used folder and a **Create
workspace** button instead — workspaces own their project folder.

#### Workspace Pane

| Control | Default | Effect |
| --- | --- | --- |
| Default new workspaces to bypass permission prompts | **Off** | Pre-checks "Bypass permission prompts" in the workspace-creation modal. Existing workspaces are unaffected. |
| Auto-detect GitHub repo on workspace creation | **On** | Runs `git remote get-url origin` at creation and links the detected repo. Turn off if you don't want that call made. |

These control the Workspace pane only; they do not change how the Agents pane
groups or resumes conversations.

#### Local terminal shell

*Applies to new or restarted local terminal panes.* Coding CLIs launch normally,
and remote workspaces always use the host's login shell.

| Control | Default | Effect |
| --- | --- | --- |
| App default | **Auto** | Auto = PowerShell on Windows, Bash on macOS/Linux. Also offers PowerShell 7, cmd, Git Bash, WSL, and Custom, per platform. |
| Workspace override · *name* | Use app default | Per-workspace override. Disabled unless an active **local** workspace is selected. |
| WSL distribution | Default distribution | Only shown for the WSL profile. |
| Shell executable / Startup arguments | — | Only shown for Custom. Must be a supported shell (pwsh, powershell, cmd, bash, zsh, fish, nu, xonsh); Auto remains the effective launch until it is valid. |

**Detect** re-scans for installed shells. **Test shell** actually launches the
resolved command and reports the executable, version, platform, and working
directory. Unavailable profiles are marked "not found" and disabled, with an
install link where one exists.

### CLI Clients

*Scope: App, New sessions.*

A catalog card, one entry per known coding CLI, showing whether each is
installed and where it was found. Per entry, depending on state:

- **Install** — runs the entry's install command in a transient PTY.
- **Browse** — pins an absolute executable path for this machine, shown as a
  manual override with a Clear button.
- **Install docs** — opens the vendor's instructions.
- Entries marked *coming soon* are listed but not installable.

Selecting the PacketCode entry reveals its integration panel (detection, doctor
status, data home, version, provider summary).

Under **Advanced — custom CLI agents**:

| Control | Effect |
| --- | --- |
| Custom | Adds a user-defined CLI agent: name, command (`claude`, `codex`, or an absolute path), description, and one argument per line. |
| Edit / Delete | Manage an existing custom agent. Delete is confirmed. |
| Reset built-ins | Clears command overrides on the built-in entries. Confirmed. |

> **Note:** The PTY command allowlist is enforced in Rust and covers `claude`,
> `codex`, `opencode`, `packetcode`, `ssh`, and the shells. A custom agent
> pointing at anything else is rejected at launch. A pinned absolute path is
> matched by its program name, so `D:\tools\packetcode.exe` is accepted.

### CLI Accounts

*Scope: App, New sessions.*

Named logins for Claude Code and Codex, so you can keep more than one
subscription available. Each row is a **pointer at a config directory** —
`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex — which is the whole
mechanism.

| Control | Effect |
| --- | --- |
| Add / Edit | Label, CLI, and config directory. A `~/.claude-work` style suggestion is offered. |
| Log in | Opens a PTY running `claude login` / `codex login` with that account's env var set. |
| Delete | Removes the **record only**. The directory and the login inside it are untouched. |

There are no secrets on this screen. A pane picks an account via its own
selector; a pane with no account uses the ambient login.

### Remote Hosts

*Scope: App, Workspace.* Full detail on [SSH remote workspaces](remote.html).

| Control | Default | Effect |
| --- | --- | --- |
| Name / Host / Port / Username | — / — / 22 / — | Identity of the host record (`ServerConfig`). |
| Auth method | **SSH Agent** | `agent`, `key` (with a validated key path), or `password`. |
| Remote path | — | Default project directory offered when creating a workspace here. |
| Verify → Trust | Unpinned | Runs `ssh-keyscan`, shows every returned key with its SHA-256 fingerprint, and pins the chosen one into `~/.packetbench/ssh/known_hosts`. |
| Test connection | — | Authenticates and checks the remote path exists, is a directory, and whether it is a Git repo. |

Saving is gated on verification for a new host or a changed hostname. Password
auth stores the password in the OS credential store under `ssh-<id>`; the form
only reports whether one exists.

Deleting shows everything currently riding on the host — connections,
conversations, Flights, workspaces — then removes the record and its stored
password. Nothing on the remote machine is deleted.

> **Warning:** A host with no pinned fingerprint falls back to TOFU
> (`accept-new`) for interactive use and is **refused outright** for async Flight
> launches.

### Project Rules

*Scope: Project.*

One editor that writes **both** `AGENTS.md` and `CLAUDE.md` at the project root,
so the same rules apply whether an agent follows the `AGENTS.md` convention or
Claude's. The editor seeds from `AGENTS.md` if present, else `CLAUDE.md`, else a
starter template.

When the two files have diverged, a warning appears with a **Unify** affordance
to collapse them onto one canonical version. With no project open, the card says
so.

---

## Agents & Models

### Agent behavior

*Scope: App, New conversations.*

#### Agents

| Control | Default | Effect |
| --- | --- | --- |
| Default launch location | **Project** | Where new conversations start: the selected project path, or a fresh project worktree. The chip in any conversation's input bar overrides it *and* updates this default. |
| Onboarding | Ready to show | **Mark complete** hides the Agents-pane onboarding; **Show again** restores it. |
| Auto-archive done conversations | **On** | Archives finished conversations after an idle period. |
| After *N* days | **14** | Idle threshold, 1–365. Disabled when auto-archive is off. |
| Auto-failover on quota or overload | **On** | Retries an API conversation on a same-provider fallback model after a rate-limit, quota, or overload error. |

> **Note:** Two persisted agent settings have **no control on this card**: the
> global transcript density (`summary` / `normal` / `verbose`, default `normal`)
> is changed from the chat header's overflow menu or by keyboard, and the
> worktree cleanup-on-archive policy (default *only when safe*) has no UI at
> all. The hourly auto-archive sweep always *keeps* worktrees regardless of that
> policy, because it cannot prompt.

#### Agent Profiles

Reusable launch presets. Three built-ins ship and are re-merged on every app
update; they are read-only but cloneable.

| Built-in | System prompt | Tools | Memory brief | Plan mode |
| --- | --- | --- | --- | --- |
| **Default** | Full autonomous agent harness | All | **On** | Off |
| **Scout** | Read-only investigator | Read-only subset | Per the Scout default | On |
| **Reviewer** | Diff critic, reports findings only | `read_file`, `list_directory`, `grep` | Off | On |

A user profile carries: name, description, system prompt, an allowed-tools list
(comma-separated; empty means all tools), a memory-brief toggle, a permission
mode (**Auto**, **Ask risky**, **Allow all**, **Deny risky**), plan mode, and an
optional **pinned model** that overrides the launcher's dropdown entirely.

The star marks the default profile. Deleting is confirmed. Changes surface
immediately in the composer's profile dropdown.

### Providers & Models

*Scope: App, New conversations.* Three cards.

#### API Keys

Stored in the **OS credential store**, never in app state or files. The card
shows only whether a key exists.

| Provider | Key required? |
| --- | --- |
| Anthropic — Claude Opus, Sonnet, Haiku | Yes |
| OpenAI — GPT-5.5, GPT-4o, o3 | Yes |
| MiniMax (Token Plan) — M3, M2.5, M2 | Yes |
| OpenRouter — 100+ models, one key | Yes |
| Ollama — local models | No |
| Custom endpoint — OpenAI-compatible | Optional; sent as a Bearer token when set |

Deleting a key is confirmed.

#### Subscriptions

`claude login` / `codex login` for the two subscription CLIs, with live auth
badges that refresh from the credential-file watcher.

| Row | What it is for |
| --- | --- |
| Anthropic (Claude subscription) | Terminal **Claude Code** sessions use your Pro/Max plan. |
| OpenAI (ChatGPT Plus/Pro) | Terminal **Codex CLI** sessions use your plan. |

> **Important:** These credentials serve **PTY / terminal CLI sessions only**.
> No agent row in the Agents picker consumes them — every API row authenticates
> with an API key. Signing in opens a terminal running the vendor's own login
> command; signing out clears the on-disk credential file.

#### Provider Endpoints

| Control | Default | Effect |
| --- | --- | --- |
| Ollama base URL | `http://localhost:11434` | Chat uses `{base}/api/chat` (the only route that accepts `num_ctx`/`keep_alive`); discovery uses `{base}/api/tags`. An endpoint without `/api/chat` falls back to `{base}/v1`, where the context window cannot be set. |
| Ollama context cap | **16384** tokens | Ceiling on the derived `num_ctx`. Under-sizing is invisible — Ollama silently drops the oldest messages. |
| Ollama keep-alive | **30m** | How long the daemon holds the model loaded. A Go duration string. |
| MiniMax base URL | `https://api.minimax.io/v1` | Mainland-China accounts must switch to `https://api.minimaxi.com/v1`; a key is valid against only one host. |
| Custom OpenAI-compatible base URL | **Unset** — the row is disabled | Used **verbatim** as `{base}/chat/completions`, so include a `/v1` prefix if your server has one. |
| Custom endpoint model list | Empty | One model id per line. No discovery route works across these servers, so the picker offers exactly what you type. |

Each row has a save tick and a reset arrow (reset returns to the built-in
default; for the custom row it clears both URL and model list).

---

## Automation

### Flights & Autonomy

*Scope: New Flights.* Two cards.

#### Flights — auto-trailer on agent commits

| Control | Default | Effect |
| --- | --- | --- |
| Append a trailer to every agent commit | **On** | Installs a `prepare-commit-msg` hook inside each Flight worktree so commits identify their originating Flight and attempt. |
| Trailer format | `Run-By: PacketBench flight F-{flightId} attempt A-{attemptId}` | Placeholders: `{flightId}`, `{attemptId}`, `{flightTitle}`. A live preview shows the substitution against sample values. |

Writes are queued and serialised; a failed save restores the previous value and
says so.

#### YOLO / bounded autonomy default

This governs **only** Flights that explicitly choose "Use Settings default".
Reviewer failures, integration conflicts, the final base-branch landing,
credentials, and work outside the allowlists still stop for you regardless.

| Control | Default | Effect |
| --- | --- | --- |
| Assisted / YOLO default | **Assisted** | Which posture a new Flight inherits. |
| Auto-recover failed attempts | On | Retry a failed attempt without asking. |
| Auto-remediate reviewer findings | On | Let the agent address review findings unattended. |
| Auto-run cooperative task graph | On | Advance the task graph without a prompt. |
| Allow unattended in-project tools | **Off** (approval-gated) | On = `allow_in_project` tool posture. |
| Allow configured draft-PR publishing | **Off** | Permits publishing an attempt as a draft PR unattended. |
| Cost $ | 25 | Spend ceiling for the Flight. |
| Minutes | 120 | Wall-clock ceiling. |
| Retries | 2 | Per task. |
| Reviews | 2 | Review rounds. |
| Agents | 3 | Maximum concurrent agents. |
| Allowed project roots | Empty | One absolute path per line. |
| Allowed targets | `local` | One per line — `local` or a server id. |

Changes are applied by **Save autonomy default**, and the confirmation states
that existing Flights keep their current policy snapshot. Selecting YOLO with an
invalid policy blocks the save and names the first problem.

#### Budget guardrails

The control surface for cost. It deliberately shows **no spend figures** — no
charts, tables, or running totals. Caps are evaluated before an agent or Flight
launches, and again on the background poll while work runs.

| Control | Default | Effect |
| --- | --- | --- |
| Daily cap $ | Off (blank) | All providers, today. |
| Monthly cap $ | Off | All providers, this month. |
| Session cap $ | Off | A single conversation. |
| Warn at % | **80** | Notify at this share of a cap. |
| Hard stop at % | **100** | Block launches at this share. Never lower than the warning threshold. |

Blank disables that cap. **Reset to defaults** clears all three caps and returns
the percentages.

### Task Role Defaults

*Scope: App, New conversations, New Flights.*

#### AI Provider Routing

A preferred agent and model per workflow role. Tasks auto-fill from these, and
automatic Flight launches (such as GitHub → Draft patch) use the
**Implementation** role.

| Role | Description |
| --- | --- |
| Implementation | Writing new code |
| Testing | Writing & running tests |
| Code Review | Reviewing code changes |
| Validation | Verifying correctness |
| Research | Exploring solutions |
| Refactoring | Improving existing code |
| Documentation | Writing docs |

Each row picks from CLI agents (marked "not installed" where applicable) or API
executors, then a model for that agent. Default for every role is
**`claude-code`** with the system default model. **Reset All** restores that.

> **Note:** Only **API executors** can run a Flight attempt, and subscription-
> login rows are deliberately excluded from this picker — nothing PacketBench
> routes automatically may resolve to subscription credentials.

#### Auxiliary AI tasks

The short single-shot generation tasks PacketBench runs on your behalf. Each row
pins a provider and optionally a model, and a **Resolves to** column shows what
the backend would actually use right now — including the error when nothing is
configured.

Default for every class is **Auto (cheapest configured)**. These never use a
Claude or ChatGPT subscription login.

| Group | Task classes |
| --- | --- |
| Spec & issues | Spec import · Spec → flight plan · Spec → tickets |
| Code Quality | Explain diagnostic · Summarize checks |
| GitHub | PR description · PR review · Catch-up digest · Issue triage · Issue investigation |
| Memory & flights | Codebase scan · Session summary · Pattern extraction · Flight retrospective |
| Chat | Agent chat · Side chat |

Pinning Ollama requires an explicit model — the backend refuses a model-less
Ollama pin, and the model select turns red until you choose one. **Reset**
returns every class to Auto.

### PacketAgent

*Scope: App, New Flights.*

Endpoint and credentials for deploying a Flight as an always-on worker.
PacketAgent owns execution; PacketBench keeps only deployment references and
event cursors.

| Control | Default | Effect |
| --- | --- | --- |
| Endpoint | `http://127.0.0.1:8484` | Base URL of the PacketAgent server. |
| PacketAgent workspace ID | — | Which remote workspace handoffs target. |
| Token | Not set | Stored in the OS credential store. Removal is confirmed. |
| Test | — | Probes `health`, then `contract`; reports the HTTP status and, when available, the schema match and permitted operations. A healthy but older server still counts as reachable. |

---

## Integrations & Data

### Git Hosts

*Scope: App, Workspace.*

| Control | Default | Effect |
| --- | --- | --- |
| GitHub connection | Disconnected | **Connect** / **Reconnect** opens the guided setup wizard, which offers browser sign-in (the GitHub device flow, when the build has an OAuth client id) and token paste on one step, validates whichever you use, and replaces the stored credential in place. **Disconnect** drops it. |
| Default merge strategy | **Squash** | Merge / Squash / Rebase — the preselected strategy in the PR action bar. |
| Require confirmation for destructive actions | **On** | Gates merge, close, and convert-to-draft. |
| Default new PRs to draft | **Off** | Pre-checks "Open as draft" in the PR modal. |
| Publish Flight attempts as draft PRs by default | **Off** | Pre-checks the equivalent option in the async Flight launcher. |
| Self-hosted Gitea / Forgejo | None | Add a base URL, an optional label, and an access token per host. Removal is confirmed. |

All git-host tokens live in the OS credential store, never in frontend state or
workspace records.

### MCP

*Scope: App, Project, New conversations.* Full detail on [MCP hub](mcp.html).
Three stacked cards.

#### Local-first MCP Hub

| Control | Effect |
| --- | --- |
| Search | Filters the catalog, configured servers, and capability text together. |
| Curated catalog → **Review** | Opens a review sheet (source, exact command, file that changes, capabilities, required secrets, network use, removal) before writing anything. Installing writes config only — nothing is executed. |
| Config scope (in the review sheet) | `project` (default) writes `<project>/.mcp.json`; `global` writes `~/.claude/settings.json`. |
| **Diagnose** | Spawns the server, handshakes, calls `tools/list`, shuts down. Reports `connected` / `degraded` / `failed` with latency and the tool list. Probes **stdio only**. |
| Read / Write / Network transport | Per-server trust. Read defaults on, Write off, Network on for stdio. Turning Read off also revokes Write. |
| Per-tool chips | Grant or revoke individual tools. A newly diagnosed server pre-grants tools whose names do not look mutating. |
| **Reconnect selected** | Closes the selected API conversation's backend so its next turn picks up the current trust snapshot. |

Credential, outside-workspace, and protected-publish operations are blocked
regardless of these toggles. Every change is written to the local trust audit.

#### MCP Servers

| Control | Default | Effect |
| --- | --- | --- |
| Add / Edit | — | Name (immutable after creation), command, space-separated args, scope, and environment pairs. Writes a **stdio** entry. |
| Delete | — | Confirmed. Removes the entry from the scope's config file. |
| On for agent sessions | All non-disabled servers | Which servers **newly started** agent conversations begin with. **Reset to all** returns to the default. |
| Refresh | — | Re-reads both config files. |

#### MCP Provider

| Control | Default | Effect |
| --- | --- | --- |
| Enable MCP Provider | **Off** | Starts a Streamable HTTP MCP server on `127.0.0.1` and shows the URL and a freshly minted bearer token. |
| Port | **3100** | Editable only while stopped. `0` lets the OS choose; the card reports the port actually bound. |
| Allow writes | **Off** | Off = strictly read-only. On enables append-only coordination notes and confined project-memory writes. Editable only while stopped. |

Live activity (tool calls and resource reads) streams while running and is
cleared when the server stops.

> **Note:** The provider's stored config also carries `allowedTools` and a
> `scope` field that are **not sent to the backend and not enforced**, and the
> card no longer surfaces them.

### Issues

*Scope: Project.* Three small cards.

| Control | Default | Effect |
| --- | --- | --- |
| Ticket Prefix | **PKT** | Prefix for generated ticket ids. Upper-cased, max 6 characters. |
| Epics | Empty | Add an epic name; existing ones render as purple chips. |
| Labels | Empty | Add a label; existing ones render as neutral chips. |

> **Note:** Epics and labels are **add-only** here — there is no remove control
> on these two cards.

### Memory

*Scope: Project, New conversations.* Full detail on [Memory](memory.html). The
card opens with counts for events, patterns, and the brief source cap, and a
button that jumps to the Memory pane. The rotate icon resets every value below.

#### Capture

| Control | Default | Effect |
| --- | --- | --- |
| Capture terminal sessions | **On** | Record PTY sessions longer than 10 seconds when they end, however they end. |
| Capture completed flights | **On** | Record a Flight when it settles as `done`. |

#### Learning

| Control | Default | Effect |
| --- | --- | --- |
| Summarize sessions on completion | **On** | Best-effort aux-LLM enrichment *after* the session is already recorded. |
| Auto-extract learned patterns | **On** | Run pattern extraction automatically once enough summaries accumulate. |
| Refresh after summaries | **3** | How many new summaries trigger an automatic extraction. Range 1–20. |

#### Retention

| Control | Default | Effect |
| --- | --- | --- |
| Expire events by age | **Off** | Enables age-based pruning. |
| Keep days | 30 | Only meaningful when expiry is on. Range 1–3650. |
| Max stored events | **200** | Oldest beyond the cap are dropped. Range 20–2000. |
| Max learned patterns | **20** | Range 1–100. |

#### Memory brief budget

| Control | Default | Effect |
| --- | --- | --- |
| Inject brief into Flight prompts | **On** | Prepend the composed brief to async Flight prompts at launch. |
| Patterns | **10** | Cap on learned patterns in a brief. Range 0–50. |
| Recent sessions | **5** | Cap on session summaries (last 48 h). Range 0–50. |
| Flight lessons | **5** | Cap on Flight lessons (last 7 days). Range 0–50. |

Project notes contribute up to **5** items, which is fixed and not configurable
here.

#### Project scope

| Control | Default | Effect |
| --- | --- | --- |
| Match memory by project path | **Exact** | Exact / Parent directory / Global. Governs filesystem paths only — a remote `ssh:` scope key always matches by exact identity. |
| Pinned patterns survive cap eviction | **On** | Off demotes pinned patterns into the same LRU as everything else. |

### Dictation

*Scope: App.* Full detail on [Dictation & analytics](dictation.html).

| Control | Default | Effect |
| --- | --- | --- |
| Whisper Models | `small` selected | Download / Verify / Use for `tiny`, `base`, `small`, `medium`, `large-v3`. A model counts as Ready only when its checksum **and** byte length match. |
| Microphone | Default | Stable CPAL device identity. Re-scan and **Test** buttons alongside. A saved-but-absent device is flagged in amber and recording falls back to the system default. |
| Maximum recording | **5 minutes** | Auto-stop and transcribe at this length. Presets 30 s / 1 / 5 / 10 / 30 min; backend clamps to 10 s – 30 min. |
| Language | **Auto-detect** | Or English, Spanish, French, German, Italian, Portuguese, Japanese, Chinese. |
| Auto-paste after transcription | **Off** | Enables automatic delivery into the field you were focused on. |
| Paste into other Windows apps | **Off**, disabled until auto-paste is on | Permits a synthetic Ctrl+V into the foreground app. Re-checked in Rust, and fails closed. |
| Custom Dictionary | Empty | Terms fed to Whisper as an initial prompt. Capped at 100 terms / 1,024 characters. |

**Test** opens the device for ~1.5 s and reports sample rate, channels, format,
peak level, and frames captured — and warns when the probe opened a *different*
device than the one saved.

### Modules

*Scope: App.*

| Module | Category | Default | Effect when off |
| --- | --- | --- | --- |
| **Code Quality** — lint, type-check, complexity, and test metrics | Analysis | **On** | Its view is removed from the navigation; if it is open you are returned to Settings. |
| **Dictation** — voice-to-text with local Whisper | Integration | **On** | Same. |

---

## Security & Diagnostics

### Trust & Diagnostics

*Scope: App.* Five stacked cards.

#### Workspace/Agents migration evidence

Local-only, content-free counters for the Workspace/Agents migration — handoff
counts and an average attention time. Nothing is uploaded, and no prompts,
transcripts, paths, files, diffs, repository URLs, tool arguments, or ids are
persisted. **Copy** puts the evidence on the clipboard; **Reset** clears it,
behind a confirmation.

#### Release Trust

Read-only status, not settings:

| Row | Current status |
| --- | --- |
| Install channel | Manual GitHub Releases |
| Code signing | Not configured for beta builds |
| Auto-updater | Runbook drafted, not enabled |
| Local release gates | lint, build, cargo check, tauri build |

> **Note:** Signing certificates and the Tauri updater are planned release-trust
> gates, not active guarantees in the current repository. Beta builds are
> installed manually.

#### Trust & Provenance

A bounded local audit of trust decisions — decision metadata only, never
transcript or tool output.

| Control | Default | Effect |
| --- | --- | --- |
| Retention | **7 days / 200 events** | Or 30 days / 200 events. |
| Source chips | **On** | Whether provenance chips are shown on evidence in the UI. |
| Copy | — | Copies a redacted audit export to the clipboard. |
| Clear | — | Clears the local audit, behind a confirmation. |

This card is marked `data-dictation="off"`, so dictation will never deliver text
into it.

#### Crash Reports

Lists crash files with timestamps; view the contents inline or delete one
(confirmed). Refresh re-reads the directory.

#### Open in dedicated view

Jump links to two surfaces that used to be Settings tabs:

| Row | Actions |
| --- | --- |
| **History** — past terminal sessions and API agent conversations | **Open** switches to the History view; **Preview** mounts it inline. |
| **Prompt Templates** — reusable prompts, expanded by typing `/` in the agent chat | **Edit** mounts the inline card, which creates and deletes templates (general / debugging / review / feature / custom) and opens the full manager for in-place editing. There is no dedicated top-level view to jump to. |

---

## Related

- [Memory](memory.html) · [Dictation & analytics](dictation.html) · [MCP hub](mcp.html) · [SSH remote workspaces](remote.html)
- [Agents & conversations](agents.html) — the picker and per-conversation overrides.
- [Flight Deck](flights.html) — how the autonomy policy is used at launch.
