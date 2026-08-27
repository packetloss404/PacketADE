# Hyper-V VM Matrix — clean-install / boot / upgrade / rollback / packaged e2e

Covers the umbrella rows that need a **real systemd boot on clean disk** —
rows 1, 5, 7, 10, 11 of the umbrella matrix plus the upgrade/rollback and
packaged-e2e rows. WSL2 is the iteration copy only; **Docker does not satisfy
these rows** (no real boot, shared kernel, different cgroup layout), and QEMU
arm64 runs are smoke only, never sign-off.

> **Gate:** any packaged-PacketBench row needs a **version bump first** —
> `package.json` / `src-tauri/tauri.conf.json` still read the already-shipped
> `0.10.5` (`backlog.md:104`); an unbumped build is indistinguishable from the
> released installer by version alone.

## VM provisioning (once)

1. Download Ubuntu 26.04 LTS **Server** ISO (amd64) and verify its SHA256
   against the Ubuntu release page.
2. Hyper-V Manager → New VM:
   - Generation 2, Secure Boot **on** with the "Microsoft UEFI Certificate
     Authority" template.
   - 4 vCPU, 8 GB RAM (static), 40 GB dynamic VHDX.
   - Default Switch (NAT) is fine; note the VM's IP after install for SSH.
3. Install Ubuntu Server (minimal), create user `proof`, enable OpenSSH
   server in the installer.
4. First boot: `sudo apt-get update && sudo apt-get -y upgrade`, then take a
   **Hyper-V checkpoint** named `pristine-26.04`. Every destructive row
   starts by reverting to this checkpoint.

## Row runbook

Each row: revert to `pristine-26.04` unless the row says otherwise; capture
evidence per `evidence-template.md` (journal excerpts via
`journalctl -u syndicate.service` / `--user` as installed).

### Row 1 — clean install on pristine OS

1. Revert to `pristine-26.04`.
2. Run the published-installer flow (same commands as `10-wsl-host-setup.sh`
   steps 4–5: fetch `install.sh` + `SHA256SUMS` from
   `packetloss404/syndicate-releases` for the target tag, `sha256sum -c`,
   run installer).
3. PASS = installer exits 0; `syndicate doctor --json` healthy; unit files
   present and enabled.

### Row 5 — service survives reboot (real boot path)

1. From an installed state (after Row 1), `sudo reboot`.
2. PASS = after boot, `systemctl status` (system or `--user` with linger, as
   installed) shows `syndicate.service` active without manual intervention;
   journal shows a clean start; a paired PacketBench reconnects.

### Row 7 — systemd hardening / cgroup behaviour

1. `systemd-analyze security syndicate.service` — record score.
2. `systemctl show syndicate.service` — record sandboxing directives; confirm
   the unit runs in its own cgroup with the documented limits.
3. Kill the main PID; PASS = restart policy behaves as documented, no orphan
   processes (`systemd-cgls`).

### Row 10 — upgrade in place

1. Install version N-1 (previous release tag), pair a device, create state.
2. Run the installer for version N.
3. PASS = service healthy on N, `doctor --json` reports N, **state preserved**
   (pairings, DB migrations applied — check `migrations` table), no re-pair
   needed.

### Row 11 — rollback

1. From the upgraded state of Row 10, run the documented rollback flow
   (per Syndicate `docs/LINUX_INSTALLER.md`; bootstrap state under
   `~/.local/state/syndicate/bootstrap/` — rollback reverts only its own
   mutations).
2. PASS = version N-1 running again, service healthy, state intact or
   explicitly documented as forward-only.

### Upgrade/rollback loop (combined evidence)

Run Rows 10 then 11 back-to-back on one VM without reverting between them;
capture one continuous journal covering install → upgrade → rollback.

### Packaged e2e (PacketBench ST8) — **blocked on version bump**

1. Bump PacketBench version, `pnpm tauri build`, install the packaged PacketBench
   on the Windows host (not in the VM).
2. Pair packaged PacketBench against the VM host (Method D), attach a session
   through a **local** `packet-relay.exe` (never production).
3. PASS = pairing, attach, terminal round-trip, and clean detach all work
   from the packaged build; card states render as in the dev build.

## Evidence

One folder per row under `evidence/vm-row-N/`; include the checkpoint name
reverted from, the ISO/tag versions, and the items from
`evidence-template.md` that apply (no HAR for headless rows — journal +
sqlite + `doctor --json` instead).
