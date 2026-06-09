import { LEGACY_STORAGE_PREFIX, STORAGE_PREFIX } from "@/lib/brand";

const GUARD_KEY = STORAGE_PREFIX + "migrated-from-packetcode";

/**
 * One-shot migration of localStorage keys from the old `packetcode:*`
 * namespace to the new `packetade:*` namespace.
 *
 * Must run before any store hydrates from localStorage. Old keys are left
 * in place as a free rollback path; new writes go exclusively to the new
 * prefix. A guard key records that migration already ran, so repeat launches
 * are effectively a no-op after the first one.
 */
export function migrateLegacyStorage(): void {
  try {
    if (localStorage.getItem(GUARD_KEY)) return;

    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }

    let migrated = 0;
    for (const key of keys) {
      if (!key.startsWith(LEGACY_STORAGE_PREFIX)) continue;

      const newKey = STORAGE_PREFIX + key.slice(LEGACY_STORAGE_PREFIX.length);
      if (localStorage.getItem(newKey) !== null) continue; // don't clobber

      const value = localStorage.getItem(key);
      if (value !== null) {
        localStorage.setItem(newKey, value);
        migrated++;
      }
    }

    localStorage.setItem(GUARD_KEY, "1");
    if (migrated > 0) {
      console.info(`[storage-migration] Copied ${migrated} packetcode:* keys to packetade:*`);
    }
  } catch (e) {
    console.warn("[storage-migration] migration failed", e);
  }
}
