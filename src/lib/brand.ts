/**
 * Central brand / identity constants.
 *
 * The product was renamed PacketCode → PacketADE. A separate TUI product is
 * taking the old "PacketCode" name. Keeping every brand/identity string
 * sourced from this file prevents future collisions and makes further renames
 * a one-file change.
 */

export const APP_NAME = "PacketADE";
export const APP_NAME_LOWER = "packetade";

/** localStorage key prefix used by all persistent stores. */
export const STORAGE_PREFIX = "packetade:";

/** Legacy localStorage prefix — read for one-shot migration on first boot. */
export const LEGACY_STORAGE_PREFIX = "packetcode:";

/** Custom URI scheme used by MCP resource URIs. */
export const URI_SCHEME = "packetade";

/** Legacy project-level deploy config filename (kept as backwards-compat alias). */
export const LEGACY_DEPLOY_CONFIG_FILENAME = "packetcode.deploy.json";

/** Current project-level deploy config filename. */
export const DEPLOY_CONFIG_FILENAME = "packetade.deploy.json";

/** Convenience: build a namespaced storage key. */
export function storageKey(suffix: string): string {
  return STORAGE_PREFIX + suffix;
}
