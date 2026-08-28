# PacketBench 0.11.0 — Packaged Acceptance Matrix

Created 2026-08-28. This is a runnable checklist, not a status report. Tick rows
as you go and record the evidence each one asks for.

The gates below have never run. `dev/proof-audit-2026-08-01.md` says why that
matters: *"fresh binaries prove compilation and bundling only."* Every green
tick in `CHANGELOG.md` for 0.11.0 today describes source tests. Nothing has been
proved about the running application.

---

## 0. Build the thing you are actually testing — do this first

**The installers currently on disk are the wrong build.** They were produced
2026-08-28 01:05 from `5f1375ca`:

| Artifact | SHA-256 |
| --- | --- |
| `PacketBench_0.11.0_x64-setup.exe` | `dd65f12b80ceb8bb225be159e1211e211e1006fb5c87362f75b6d1079d55b500` |
| `PacketBench_0.11.0_x64_en-US.msi` | `19731f62cdb31c40bdb228117ceeadb7b4ea0c6a82ec10b99e99cc8c237b5cb7` |

Six commits have landed since, including **every dictation fix and the entire
analytics port**. Sections 3 and 4 of this matrix cannot be run against those
files — they would test the code the fixes replaced.

**Bump the version before rebuilding.** Both `package.json` and
`src-tauri/tauri.conf.json` still read `0.11.0`, so a rebuild produces a second
pair of `PacketBench_0.11.0_*` installers with different hashes and nothing to
tell them apart — the exact collision `CHANGELOG.md` records for the two
0.10.5 builds and warns must not recur. Move to `0.11.1` first.

```bash
export PATH="/c/Users/ianwalmsley/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH" && cd /d/projects/PacketBench && pnpm tauri build
```

Afterwards run `pnpm sidecar:install` — `prebundle` strips the sidecar's
devDependencies.

- [ ] Version bumped in both files
- [ ] Rebuilt; record commit, both filenames and both SHA-256s in `CHANGELOG.md`

---

## 1. The migration path — the single most valuable test here

The rename moved the Tauri bundle identifier (`com.packetade.desktop` →
`com.packetbench.desktop`) and every one-shot data-dir, keyring, and
localStorage migrator (`LEGACY_*` in `src-tauri/src/core/brand.rs` and
`src/lib/brand.ts`). **Those migrators have only ever run from a source build.**
No installed, upgraded PacketBench package has ever existed.

Run this on a machine (or VM snapshot) carrying pre-rename `packetade` state.

- [ ] Data dir migrates `.packetade` → `.packetbench`; flights, issues, workspaces, and history all survive
- [ ] Keyring secrets migrate from the legacy service name — API keys and git host tokens still work without re-entry
- [ ] `packetade:*` localStorage keys migrate to `packetbench:*`
- [ ] The new bundle identifier does **not** install alongside the old app as a second entry in Add/Remove Programs
- [ ] Launch a second time — migrators are one-shot and must not re-run or double-apply
- [ ] A **clean-machine** install (no prior state) also launches correctly

Evidence: commit, package SHA-256, host OS build, and what pre-rename state the
machine carried.

---

## 2. Launch, lifecycle, and shell

- [ ] Cold start to usable window
- [ ] Window state and active view restore across restart
- [ ] Close with live work running — confirmation appears and is honest about what is lost
- [ ] After exit, no orphaned `claude` / `codex` / `node` processes remain (Task Manager)
- [ ] Terminal shells: Auto, PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, WSL
- [ ] Unavailable-profile recovery — pick a shell that is not installed; the failure is stated, not silent
- [ ] Pane, workspace, and app-level persistence and hydration of terminal sessions
- [ ] Claude statusline self-bootstraps. **A pane launched by an older binary must be restarted** — collector injection happens at session launch (`dev/release-v0.10.3.md`)
- [ ] A CLI that crashes on startup reports something. Known live case: `codex` 0.147.0 access-violates (`0xC0000005`). Backlog records that every `pty:exit` listener discards the payload, so this currently renders as a clean exit — confirm whether that is still true in the package

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
