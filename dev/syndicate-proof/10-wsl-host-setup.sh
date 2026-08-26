#!/usr/bin/env bash
# Phase 1 — WSL Ubuntu-26.04 Syndicate Host setup.
#
# Run INSIDE the WSL distro (systemd must be PID 1):
#   wsl -d Ubuntu-26.04
#   bash /mnt/d/projects/PacketADE/dev/syndicate-proof/10-wsl-host-setup.sh
#
# Installs Syndicate from the PUBLISHED release installer
# (github.com/packetloss404/syndicate-releases) with SHA256SUMS verification
# per the Syndicate repo's docs/LINUX_INSTALLER.md — NEVER from the working
# tree at D:\projects\syndicate.
#
# Version note: the 2026-08-16 plan said v0.1.3; the Syndicate tree's
# docs/LINUX_INSTALLER.md records v0.2.1 as the live verified release, so
# that is the default here. Override: SYNDICATE_VERSION=v0.1.3 bash 10-...
set -euo pipefail

SYNDICATE_VERSION="${SYNDICATE_VERSION:-v0.2.1}"
RELEASE_BASE="https://github.com/packetloss404/syndicate-releases/releases/download/${SYNDICATE_VERSION}"
WORK_DIR="$(mktemp -d /tmp/syndicate-install.XXXXXX)"

log() { printf '\n==> %s\n' "$*"; }

# --- 0. Sanity: systemd PID 1 (required for the syndicate.service rows) ----
if [[ "$(ps -p 1 -o comm=)" != "systemd" ]]; then
  echo "FAIL: PID 1 is not systemd. Enable systemd in /etc/wsl.conf ([boot] systemd=true), run 'wsl --shutdown', and retry." >&2
  exit 1
fi

# --- 1. Packages ------------------------------------------------------------
log "apt: sqlite3, openssh-server, curl, ca-certificates"
sudo apt-get update
sudo apt-get install -y sqlite3 openssh-server curl ca-certificates

# --- 2. Node per Host engines (>= 24.14.0) ----------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  have="$(node --version | sed 's/^v//')"
  if [[ "$(printf '%s\n' '24.14.0' "$have" | sort -V | head -n1)" == "24.14.0" ]]; then
    need_node=0
    log "node v${have} already satisfies >=24.14.0"
  fi
fi
if [[ "$need_node" == "1" ]]; then
  log "installing Node 24.x via NodeSource"
  curl --proto '=https' --tlsv1.2 -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

# --- 3. sshd + user lingering ----------------------------------------------
log "enabling ssh and user lingering"
sudo systemctl enable --now ssh
loginctl enable-linger "$USER" || sudo loginctl enable-linger "$USER"

# --- 4. Syndicate via published installer (verified) ------------------------
log "fetching ${SYNDICATE_VERSION} installer + SHA256SUMS from syndicate-releases"
cd "$WORK_DIR"
curl --proto '=https' --tlsv1.2 -fsSLO "${RELEASE_BASE}/install.sh"
curl --proto '=https' --tlsv1.2 -fsSLO "${RELEASE_BASE}/SHA256SUMS"

log "verifying install.sh against the release SHA256SUMS (per docs/LINUX_INSTALLER.md)"
grep -E '(^|/| )install\.sh$' SHA256SUMS > SHA256SUMS.install
sha256sum -c SHA256SUMS.install

log "running verified installer"
bash ./install.sh --version "${SYNDICATE_VERSION}"

# --- 5. Doctor --------------------------------------------------------------
log "syndicate doctor --json"
if ! command -v syndicate >/dev/null 2>&1; then
  # Installer may put it on a login-shell PATH; try the common location.
  export PATH="$HOME/.local/bin:$PATH"
fi
syndicate doctor --json | tee "$HOME/syndicate-doctor-$(date -u +%Y%m%dT%H%M%SZ).json"

log "DONE. Host state DB (once the host has run): ~/.local/state/syndicate/data/syndicate.db"
log "Next: pair PacketBench (Method D), then run rows per 40-expiry-row-runbook.md using 20-method-a.sh."
