# Packaged Acceptance Matrix — currently targeting 0.13.1

> **The filename carries no version, deliberately.** This is one evolving
> checklist, not a per-release artifact. It used to be renamed on every
> retarget (`acceptance-0.11.0.md` → `-0.12.0` → `-0.12.1` → `-0.13.0` →
> `-0.13.1`), which permanently broke every link that pointed at it: the 0.12.0
> and 0.12.1 entries in `CHANGELOG.md` had been citing a filename that had not
> existed for two releases, and were repointed here when the name was fixed.
> The name is now stable at `dev/acceptance.md`; the version it targets is
> stated in the heading above and in section 0, where it can change without
> invalidating a link.

Created 2026-08-28 for 0.11.0, then retargeted to 0.12.0, 0.12.1, 0.13.0 and now
0.13.1 — each time after section 0 was re-executed against a fresh build,
because an earlier build does not contain the work that landed after it. This is
a runnable checklist, not a status report. Tick rows as you go and record the
evidence each one asks for.

**When you retarget it:** rebuild, rewrite section 0 with the new commit,
filenames and hashes, update the heading, and re-examine every ticked row —
a tick earned against an older build is evidence about that build, not this
one. Do not rename the file.

Sections 2–5 remain **substantially** unrun. `dev/proof-audit-2026-08-01.md`
says why that matters: *"fresh binaries prove compilation and bundling only."*
Most green ticks in `CHANGELOG.md` for those sections still describe source
tests.

Three packaged installs have now happened, all silent and per-user: 0.12.1
(2026-08-29), then 0.13.0 and 0.13.1 (both 2026-08-30). 0.13.1 is the first
build whose UI anyone has actually driven.

**Section 2 was run against 0.13.1 on 2026-08-30** and is now largely closed:
six of its eleven rows pass outright, two are partial, one is blocked for want
of a host missing a shell, and one is a confirmed-still-broken finding. Sections
**3–5 remain entirely unrun** — they need a person at the keyboard with the
headset attached. Read each row's own note; several passes are narrower than a
tick suggests.

---

## 0. Build the thing you are actually testing — DONE 2026-08-30

Built from `8dc13780`, **unsigned**:

| Artifact | SHA-256 |
| --- | --- |
| `PacketBench_0.13.1_x64-setup.exe` (NSIS, 85.4 MiB) | `10814779d13001ea4517c706eaf62adc55c21701abe6ed37821d3994a58c8a4e` |
| `PacketBench_0.13.1_x64_en-US.msi` (133.2 MiB) | `d0caf91b45d3903ae42eda1bd28754b3600e9d9336f50fbb82cf2d2b66c11f68` |

The 0.11.0, 0.12.0, 0.12.1 and 0.13.0 bundles remain on disk and are **not**
what this matrix accepts. Check the version in the filename before installing.

They live in `C:/Users/ianwalmsley/packetbench-build/release/bundle/`, not in the
repo. Every build here is made from a committed tree with a clean working
directory, so each artifact maps to exactly one commit — an earlier 0.12.0 pair
that spanned a source edit was deleted for failing that rule, because an
installer you cannot attribute is worse than none.

```bash
export PATH="/c/Users/ianwalmsley/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH" && cd /d/projects/PacketBench && pnpm tauri build
```

Afterwards run `pnpm sidecar:install` — `prebundle` strips the sidecar's
devDependencies. (Done for this build.)

- [x] Version bumped — 0.13.0 → **0.13.1** in `package.json`,
      `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ `Cargo.lock`)
- [x] Rebuilt; commit, both filenames and both SHA-256s recorded in `CHANGELOG.md`

---

## 1. The migration path — the single most valuable test here

**Partially run 2026-08-28, from source and against a copy of a real legacy data
dir. It found two defects.** The rows below that need an installed upgrade are
still open.

The rename moved the Tauri bundle identifier (`com.packetade.desktop` →
`com.packetbench.desktop`) and every one-shot data-dir, keyring, and
localStorage migrator (`LEGACY_*` in `src-tauri/src/core/brand.rs` and
`src/lib/brand.ts`). **Those migrators have only ever run from a source build.**
No installed, upgraded PacketBench package has ever existed.

Run the remaining rows on a machine (or VM snapshot) carrying pre-rename
`packetade` state.

- [x] **DEFECT FOUND AND FIXED — data dir.** A `~/.packetade` carrying both our
      markers and the packetcode TUI's classified `Foreign`, vetoing the whole
      migration and abandoning our own state in the same directory. On the
      development machine that stranded `state.v1.json` at version 1471 with 14
      issues and 3 workspaces. Such a directory is now `Mixed`: our entries are
      copied out, the legacy dir is left exactly as found. Verified against a
      copy of that real directory — classified `Mixed`, all 41,885 bytes
      recovered byte-identically, `config.toml`/`cost-tally.json` left behind,
      legacy dir intact. Fixed in `544e4cc6`.
- [x] **DEFECT FOUND, NOT FIXED — localStorage.** WebView2 keys its profile by
      bundle identifier, so a packaged upgrade gets an empty profile and
      `migrateLegacyStorage()` finds nothing to migrate. Twelve stranded keys
      measured. Filed in `backlog.md`; needs an owner decision.
- [x] Keyring migration reviewed — per-key, read-through, write-new-then-delete-legacy,
      with tests covering partial failure. No analogous flaw. **Still needs a
      packaged run to confirm end to end.**
- [x] **The new bundle identifier does not install alongside the old app.**
      Verified 2026-08-30 twice: after installing 0.13.0 over 0.12.1, and again
      after 0.13.1 over 0.13.0, Add/Remove Programs holds exactly one
      `PacketBench` entry, reading the version just installed.
- [x] **A same-identifier upgrade preserves the data dir.** Run twice, both
      silent per-user installs, both exit 0, both with the installer's SHA-256
      checked against `CHANGELOG.md` first.
      - 0.12.1 → 0.13.0: workspaces and agents came through unchanged;
        `state.v1.json` advanced 69 → 78 afterwards.
      - 0.13.0 → 0.13.1: data dir **byte-identical** across the install — 14
        files, 408,164 bytes, `state.v1.json` v90, 1 workspace, measured before
        and after. After launching and using the app it advanced to v99 and
        408,200 bytes, so the upgrade preserved state *and* left it writable.
      The installed `packetbench.exe` reports file version 0.13.1. Note it is
      **not** byte-identical to `release/packetbench.exe`: the bundler patches
      that file in place with bundle-type information for each target, so the
      build artifact left on disk is not what got packaged. The version
      resource is the check that means something.
- [ ] **Data dir migrates from PRE-RENAME state on a real installed upgrade** —
      still open, and this machine cannot prove it: `~/.packetbench` already
      exists, so `migrate_data_dir_in` correctly returns early and the legacy
      `~/.packetade` (version 1471, 14 issues, 3 workspaces) is left untouched,
      exactly as designed. Proving this row needs a machine or VM snapshot that
      has `~/.packetade` and **no** `~/.packetbench`.
- [ ] Keyring secrets migrate — API keys and git host tokens still work without re-entry
- [ ] Launch a second time — migrators are one-shot and must not re-run or double-apply
- [ ] A **clean-machine** install (no prior state) also launches correctly

Evidence: commit, package SHA-256, host OS build, and what pre-rename state the
machine carried.

---
## 2. Launch, lifecycle, and shell

- [x] **Cold start to usable window** — 2026-08-30. Installed 0.13.1 launched,
      stayed up with its Node sidecar, and **the window was looked at**: it
      renders correctly, and the Agents and PacketCode routes both mount and
      navigate (four switches via the command palette). This closes the "needs
      eyes on it" caveat that stood against 0.13.0.

      **Extended 2026-08-30 (same session).** The Left Rail is now exercised
      too: all seven rail routes were clicked and each rendered, confirmed by
      the status strip naming the active view — Workspace, Agents, PacketCode,
      Flight Deck, Issues, Memory, Git Hosts. Memory shows a proper explanatory
      empty state rather than empty frames, and Git Hosts shows its "Set up a
      git host" entry. The earlier caveat that the rail was unexercised is
      retired.

      Still not covered: Flight Deck, Issues and the Tools/Settings surfaces
      were only seen empty, and nothing was driven inside them.
- [x] **No console window on agent-route mount** (regression check for the fix
      in 0.13.1). Four Agents ↔ PacketCode switches, screenshotted at 1s and 4s
      each: no console window at any point. The meaningful half of this is that
      a `packetcode` process *was* running with an empty `MainWindowTitle`, so
      the engine spawned and was hidden — "no window" is not merely "nothing
      ran". Before the fix the `doctor --json` probe and the engine spawn in
      `acp/mod.rs` set no `CREATE_NO_WINDOW`, and both agent routes probe on
      mount.
- [x] **The ACP model picker offers no invented ids** (regression check for the
      other 0.13.1 fix). The picker reads "Engine default" and its dropdown
      says the engine has not reported models yet — no `claude-opus-4-8`, which
      on an engine with no Anthropic provider went to OpenAI and 404'd.
- [~] **Window state and active view restore across restart** — PARTIAL,
      2026-08-30, and one half of it is my fault.
      - **Active view restores.** Closed on Workspace, reopened on Workspace.
      - **Active workspace does NOT restore.** Workspace 2 was the selected tab
        with six panes showing; after restart both tabs are present but neither
        is selected and the main pane reads "Select a workspace from the sidebar
        or create a new one". The workspace and its sessions persist — you just
        have to click it again.
      - **Window position is untested, not passed.** I moved the window with
        `SetWindowPos` rather than dragging it, and an external move may not
        fire what the app persists. It reopened at its pre-move position. Redo
        this by dragging the window by hand before trusting either answer.
- [x] **Close with live work running — confirmation appears and is honest.**
      Six terminals running; the dialog says "Closing now terminates work that
      is still running. Nothing is resumed on restart." and lists "6 terminal
      sessions will be killed". The count is exact — it matched both the six
      panes and the six shell processes parented to `packetbench`. It names the
      consequence, states that nothing resumes, and quantifies the loss.
- [x] **After exit, no orphaned processes.** Measured, not eyeballed. All six
      shell PIDs recorded before the close (bash 29336, cmd 52924, powershell
      46972 + 33804, pwsh 19308, wsl 29088) were gone afterwards;
      `packetbench` at 0 processes; no `node` / `claude` / `codex` process left
      with a dead parent; no `node` whose command line mentions the sidecar.
      One `cmd.exe` (4076) does have a dead parent — it was already orphaned
      before this test began and is not PacketBench's.
- [x] **Terminal shells: all six launch and are usable.** Each was selected from
      the Terminal row's profile dropdown, launched, and its banner/prompt read.
      | Profile | Result |
      | --- | --- |
      | Auto-detect | resolves to Windows PowerShell; pane is honestly labelled "Windows PowerShell (Auto)" |
      | PowerShell 7 | `PowerShell 7.6.5`, `PS D:\projects\PacketBench>` |
      | Windows PowerShell | banner + `PS D:\projects\PacketBench>` |
      | Command Prompt | `Microsoft Windows [Version 10.0.26200.9168]`, `D:\projects\PacketBench>` |
      | Git Bash | `MINGW64 /d/projects/PacketBench (main)` — git-aware |
      | WSL | `ianwalmsley@POINT9:/mnt/d/projects/PacketBench$`; **translates the Windows project path to the WSL mount**; `whoami` returned `ianwalmsley` |

      Corroborated at the OS level: exactly six shell processes parented to
      `packetbench`, one per pane, and the two `powershell.exe` children confirm
      Auto-detect landed on Windows PowerShell rather than pwsh.

      Note for whoever reads this next: the native profile dropdown photographs
      **blank** under screenshot capture. That is a capture artifact of the OS
      popup, not a rendering defect — the values read correctly in the closed
      control. Do not file it as a bug.
- [ ] **Unavailable-profile recovery — BLOCKED, not failed.** Every one of the
      six profiles the picker offers is installed on this machine, so there is
      no unavailable shell to select. Making one unavailable means modifying the
      user's system, which is not a thing to do for a test. Needs a host missing
      at least one profile.

      Adjacent evidence that the failure path does speak up: the pre-existing
      workspace points at `D:\projects\PacketBench-0.11.0-portable`, which does
      not exist, and the sidebar states exactly that in red — "Project path is
      not a directory: …". **But clicking that workspace does nothing visible**:
      the main pane stays on "Select a workspace from the sidebar or create a
      new one" with no explanation. The failure is stated, but not where the
      user's click was.
- [x] **Pane, workspace, and app-level persistence and hydration.** Verified at
      all three levels across a real close/relaunch.
      - Workspace 2 and all six sessions persisted (`Terminal x6`).
      - **Hydration is dormant, as documented:** zero shell children at app
        start. Nothing is launched until a workspace is opened.
      - Opening the workspace launched six shells with **new PIDs** (13004,
        7660, 47860, 46920, 47824, 52624) — fresh sessions, not resumptions,
        which is what the close dialog promised. The WSL pane no longer carries
        the `whoami` I ran before the close.
- [~] **Claude statusline self-bootstraps — PARTIAL.** The statusline appears on
      launch and polls ("Claude Code — Collecting session status…"), so the
      collector is injected at session launch as designed. It never populates,
      because Claude Code stops at its folder-trust prompt and I did not answer
      a security prompt on the user's behalf. Finish this row by launching a
      Claude pane, accepting the trust prompt yourself, and confirming the
      statusline fills in.
- [x] **A CLI that crashes on startup reports something — CONFIRMED STILL
      BROKEN, by source rather than by the crash.** The named case is gone:
      `codex` is now **0.150.1**, not 0.147.0; `codex --version` returns
      cleanly and a Codex pane launches to its own trust prompt with no access
      violation. So the runtime reproduction is no longer available on this
      machine.

      The underlying defect is nonetheless still present in 0.13.1, and this is
      checkable without a crash. Rust emits a real payload
      (`commands/pty.rs:538` — `exitCode`, `terminated`), and
      `parsePtyExitPayload` (`src/lib/tauri.ts:227`) exists to read it. **It has
      zero non-test callers.** All three listeners take no parameter and discard
      the payload: `useTerminalSession.ts:360`, `useTransientPty.ts:150` and
      `:276`. The exit code therefore never crosses the event boundary, and a
      CLI that dies on startup still renders identically to a clean exit.

---

## 3. Dictation — now testable, and the highest-yield section

DV1–DV16 has been source-complete and hardware-unproven for weeks. The
2026-08-28 hardening pass fixed defects that **can only be confirmed with a real
microphone**. Your PLT Focus Bluetooth headset is present and healthy
(`Headset (PLT Focus)`, `Headset (PLT Focus Hands-Free)`, `PltHeadsetDataService`).

### 3a. The Bluetooth paths the fixes were written for

- [ ] **Walk out of range mid-sentence.** Partial audio must be transcribed and delivered, with the device error shown as a warning — not lost behind an error. This is the salvage path; it is new and unproven
- [ ] Power the headset off mid-capture — same expectation
- [ ] **Silent stall.** Does a dropout raise `dictation:error`, or does the stream just stop delivering frames and trip the 2s stall watch? Both paths are handled; **which one actually fires on WASAPI is unknown.** Record which
- [ ] Stall threshold does not false-positive on ordinary SCO stutter during a long dictation
- [ ] **Mid-capture profile switch** (A2DP ↔ hands-free). If the OS re-rates the stream underneath, the transcript comes out pitch- and speed-shifted. Deliberately provoke this — it was flagged unfixable without hardware
- [ ] Reconnect the headset and dictate again — device identity re-resolves

### 3b. Capture and transcription

- [ ] Fast push-to-talk tap (<250ms) produces nothing, not hallucinated filler
- [ ] Cancel mid-capture, and cancel mid-transcription (Escape) — both release the device
- [ ] Same phrase twice in a row — both delivered, second not swallowed
- [ ] First-model-load latency is visible as such, not a silent spinner
- [ ] A long dictation near the capture ceiling
- [ ] USB or built-in mic for the 44.1/48 kHz comparison the headset cannot provide

### 3c. Delivery — verify the safety fixes hold

- [ ] Dictate into a composer, then **click into a different pane before the transcript returns**. It must go to the field you started in, or the clipboard — never the new focus
- [ ] Dictate with a **terminal pane focused**. Text must arrive without executing — no newline may reach the shell
- [ ] Focus a **password field** and dictate. Nothing may be typed into the form behind it
- [ ] System-wide paste stays off unless explicitly enabled, and is refused when the setting is off

### 3d. Settings surfaces

- [ ] Device picker disambiguates the headset's near-identical names
- [ ] Disconnect the headset — the picker says the saved device is absent rather than showing "Default"
- [ ] Microphone test reports honestly when it falls back to a different device
- [ ] Global shortcuts are **off** by default

---

## 4. Dictation analytics — never seen running

- [ ] Analytics tab renders with a real history; no empty or broken panels
- [ ] Fresh install (zero entries) shows the explanatory empty state, not 21 empty frames
- [ ] **Sentiment** is scored on new dictation. Existing rows stay NULL by design — coverage must read honestly ("scored N of M"), and `0` must never render as "Neutral"
- [ ] Cumulative charts start from `dailySeriesCarry`, not from zero
- [ ] Streak numbers agree with what the history list shows
- [ ] **UTC vs local:** dictate near local midnight. Analytics bucket in UTC while history displays in your zone — confirm the disagreement is the known one and note how wrong it looks
- [ ] New **General → Date & Time** setting persists across restart and changes displayed timestamps

---

## 5. Monitor, accessibility, denial

- [ ] Two-display lifecycle (this machine has two)
- [ ] Monitor closes with the main process; no stale window survives
- [ ] WebView-to-Rust denial holds
- [ ] Navigation, tab, and menu ARIA; keyboard reachability
- [ ] Responsive overflow from 800px to ultrawide
- [ ] Denial floors hold — a refused permission stays refused

---

## Blocked — needs environment you have not set up

Not failures. Record as blocked, with what is missing.

| Gate | Missing |
| --- | --- |
| SSH / remote sidecar parity | A pinned SSH host |
| GitHub / Gitea Issue↔Flight mirroring | Two disposable repos and both credentials |
| PacketAgent PH10 live e2e | A running instance on `127.0.0.1:8484` and a minted credential |
| PacketCode release proof | Published signed artifacts |
| macOS / Linux | Those hosts |

---

## Recording rules

From `dev/proof-audit-2026-08-01.md`, unchanged:

- Record the exact commit, package SHA-256, host OS, and fixture used.
- **Never** log bearer values, API keys, SSH hostnames, or unredacted remote config.
- A fixture restart is source evidence. Only a real separately-running process
  proves durability.
- Promote a gate to closed in `backlog.md` only after the packaged run, not
  after the build.
