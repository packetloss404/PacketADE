import { LEGACY_STORAGE_PREFIX, STORAGE_PREFIX } from "@/lib/brand";

const GUARD_KEY = STORAGE_PREFIX + "migrated-from-packetade";

/**
 * One-shot migration of localStorage keys from the old `packetade:*`
 * namespace to the new `packetbench:*` namespace.
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
      console.info(`[storage-migration] Copied ${migrated} packetade:* keys to packetbench:*`);
    }
  } catch (e) {
    console.warn("[storage-migration] migration failed", e);
  }
}

const ISSUES_KEY = STORAGE_PREFIX + "issues";
const MISSION_TO_FLIGHT_GUARD = STORAGE_PREFIX + "migrated-mission-to-flight";

/**
 * One-shot: rewrite the legacy `missionId` flight link on persisted issues to
 * the canonical `flightId`, so the read-side fallback in `issueStore` can be
 * retired a release later (the Mission→Flight rename kept `missionId` as a
 * read alias).
 *
 * Must run AFTER {@link migrateLegacyStorage} (which copies `packetcode:issues`
 * into `packetbench:issues`) and BEFORE any store hydrates. Guarded so repeat
 * launches are a no-op, and skipped entirely when the blob has no `missionId`.
 */
export function migrateIssuesMissionToFlight(): void {
  try {
    if (localStorage.getItem(MISSION_TO_FLIGHT_GUARD)) return;

    const raw = localStorage.getItem(ISSUES_KEY);
    if (raw && raw.includes("missionId")) {
      const parsed = JSON.parse(raw) as { issues?: unknown };
      if (parsed && Array.isArray(parsed.issues)) {
        let rewritten = 0;
        parsed.issues = parsed.issues.map((issue) => {
          if (issue && typeof issue === "object" && "missionId" in issue) {
            const { missionId, ...rest } = issue as Record<string, unknown> & {
              missionId?: string | null;
              flightId?: string | null;
            };
            rewritten++;
            return { ...rest, flightId: missionId ?? rest.flightId ?? null };
          }
          return issue;
        });
        if (rewritten > 0) {
          localStorage.setItem(ISSUES_KEY, JSON.stringify(parsed));
          console.info(
            `[storage-migration] Rewrote missionId→flightId on ${rewritten} issue(s)`,
          );
        }
      }
    }

    localStorage.setItem(MISSION_TO_FLIGHT_GUARD, "1");
  } catch (e) {
    console.warn("[storage-migration] mission→flight issue migration failed", e);
  }
}
