#!/usr/bin/env bash
# Method A helper — drive the Syndicate Host's grant-expiry predicate by
# editing controller_devices.grant_expires_at in the Host STATE database.
#
# Editing the STATE DB is prescribed by the expiry runbook; the read-only
# prohibition covers only the Syndicate SOURCE tree. Always `backup` before
# the first mutation of a session.
#
# What this exercises: the Host-side auth predicate
#   apps/host/src/controller-auth.ts:536
#   (row.status !== 'active' || Date.parse(row.grant_expires_at) <= now)
# and PacketADE's card/banner states derived from grantExpiresAt
#   (SYNDICATE_GRANT_WARNING_DAYS = 7, Math.ceil days-remaining).
# What it does NOT exercise: the relay-side expiry of the SIGNED grant
# (relay_grant_json / relay_grant_signature_base64url are left untouched and
# cannot be forged) — those are rows 5/5b/6b, Method B only.
#
# Usage:
#   20-method-a.sh backup                # timestamped copy of syndicate.db
#   20-method-a.sh show                  # SELECT the relevant columns
#   20-method-a.sh expired   [device_id] # set expiry ~1 hour in the past
#   20-method-a.sh plus3d    [device_id] # now + 3 days   (expect: warning, 3d)
#   20-method-a.sh plus7d    [device_id] # now + 7 days   (boundary: warning, 7d)
#   20-method-a.sh plus8d    [device_id] # now + 8 days   (expect: valid, no warning)
#   20-method-a.sh plus6d20h [device_id] # now + 6d20h    (ceil -> warning, 7d)
#   20-method-a.sh restore <backup-file> # restore a backup (stop host first)
#
# device_id optional: with no id, ALL controller_devices rows are updated
# (fine on a single-device proof host). Timestamps are written in the same
# ISO-8601 milliseconds+Z shape the Host writes (Date.toISOString()).
#
# Restart or re-attach is NOT required for the auth predicate — it reads the
# row per request — but restart syndicate.service when a row's steps say so,
# to also prove the freshly-loaded path:
#   systemctl --user restart syndicate.service
set -euo pipefail

DB="${SYNDICATE_DB:-$HOME/.local/state/syndicate/data/syndicate.db}"
CMD="${1:-}"; ARG="${2:-}"

die() { echo "FAIL: $*" >&2; exit 1; }
[[ -n "$CMD" ]] || die "no command. See header for usage."
[[ -f "$DB" || "$CMD" == "restore" ]] || die "state DB not found: $DB (set SYNDICATE_DB to override)"

iso_expr() { # $1 = sqlite datetime modifiers, e.g. "'now','+3 days'"
  echo "strftime('%Y-%m-%dT%H:%M:%fZ', $1)"
}

set_expiry() { # $1 = modifiers, $2 = optional device id
  local expr where=""
  expr="$(iso_expr "$1")"
  [[ -n "${2:-}" ]] && where=" WHERE id = '$2'"
  sqlite3 "$DB" "UPDATE controller_devices SET grant_expires_at = ${expr}${where};"
  echo "-- after UPDATE (${1}${2:+ on $2}):"
  show
}

show() {
  sqlite3 -header -column "$DB" \
    "SELECT id, status, approved_at, grant_expires_at,
            substr(relay_grant_json, 1, 60) AS grant_head
     FROM controller_devices;"
}

case "$CMD" in
  backup)
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    dest="${DB}.bak-${stamp}"
    # .backup is safe against a live writer (uses the sqlite backup API).
    sqlite3 "$DB" ".backup '${dest}'"
    echo "PASS: backup written: $dest"
    ;;
  show)      show ;;
  expired)   set_expiry "'now','-1 hour'"            "$ARG" ;;
  plus3d)    set_expiry "'now','+3 days'"            "$ARG" ;;
  plus7d)    set_expiry "'now','+7 days'"            "$ARG" ;;
  plus8d)    set_expiry "'now','+8 days'"            "$ARG" ;;
  plus6d20h) set_expiry "'now','+6 days','+20 hours'" "$ARG" ;;
  restore)
    [[ -n "$ARG" && -f "$ARG" ]] || die "restore needs an existing backup file argument"
    echo "Stopping syndicate.service before restore (ignore errors if not running)..."
    systemctl --user stop syndicate.service || true
    cp -f -- "$ARG" "$DB"
    rm -f -- "${DB}-wal" "${DB}-shm"
    systemctl --user start syndicate.service || true
    echo "PASS: restored $ARG -> $DB"
    show
    ;;
  *) die "unknown command '$CMD'" ;;
esac
