import { LEGACY_STORAGE_PREFIX, STORAGE_PREFIX } from "@/lib/brand";

const GUARD_KEY = STORAGE_PREFIX + "migrated-from-packetade";
const RECORD_KEY = STORAGE_PREFIX + "storage-migration-record";

/**
 * What the legacy migration actually saw, written down at the moment it ran.
 *
 * `legacyKeysFound: 0` is the whole point of this record. A packaged upgrade
 * across a bundle-identifier change gives the app a NEW, EMPTY WebView2
 * profile, so the migrator finds nothing, writes its guard key, and completes
 * — indistinguishable from a machine that simply had nothing to migrate. That
 * silence is what made the 2026-08-28 data loss hard to find (`backlog.md`).
 * Recording the count turns an absence into a fact the next person can read.
 */
export interface LegacyMigrationRecord {
  /** Epoch ms when the migration ran. */
  at: number;
  /** `packetade:*` keys present in this origin when it ran. */
  legacyKeysFound: number;
  /** How many were copied forward (found, minus any that would clobber). */
  migrated: number;
}

export type LegacyMigrationOutcome =
  | { status: "ran"; record: LegacyMigrationRecord }
  /** Guard key present. `record` is null on installs that migrated before this
   *  record existed — "we don't know", which is itself worth showing. */
  | { status: "already-ran"; record: LegacyMigrationRecord | null }
  | { status: "failed"; error: string };

/** Read the durable record written by {@link migrateLegacyStorage}. */
export function readLegacyMigrationRecord(): LegacyMigrationRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LegacyMigrationRecord>;
    if (typeof parsed?.legacyKeysFound !== "number") return null;
    return {
      at: typeof parsed.at === "number" ? parsed.at : 0,
      legacyKeysFound: parsed.legacyKeysFound,
      migrated: typeof parsed.migrated === "number" ? parsed.migrated : 0,
    };
  } catch {
    return null;
  }
}

/**
 * One-shot migration of localStorage keys from the old `packetade:*`
 * namespace to the new `packetbench:*` namespace.
 *
 * Must run before any store hydrates from localStorage. Old keys are left
 * in place as a free rollback path; new writes go exclusively to the new
 * prefix. A guard key records that migration already ran, so repeat launches
 * are effectively a no-op after the first one.
 *
 * Returns what it saw rather than `void`, and writes the same facts to
 * {@link RECORD_KEY} so they outlive the console. The record is under the
 * `packetbench:` prefix, so the durable storage mirror carries it too.
 */
export function migrateLegacyStorage(): LegacyMigrationOutcome {
  try {
    if (localStorage.getItem(GUARD_KEY)) {
      return { status: "already-ran", record: readLegacyMigrationRecord() };
    }

    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }

    const legacyKeys = keys.filter((key) => key.startsWith(LEGACY_STORAGE_PREFIX));
    let migrated = 0;
    for (const key of legacyKeys) {
      const newKey = STORAGE_PREFIX + key.slice(LEGACY_STORAGE_PREFIX.length);
      if (localStorage.getItem(newKey) !== null) continue; // don't clobber

      const value = localStorage.getItem(key);
      if (value !== null) {
        localStorage.setItem(newKey, value);
        migrated++;
      }
    }

    const record: LegacyMigrationRecord = {
      at: Date.now(),
      legacyKeysFound: legacyKeys.length,
      migrated,
    };
    localStorage.setItem(GUARD_KEY, "1");
    try {
      localStorage.setItem(RECORD_KEY, JSON.stringify(record));
    } catch {
      // A full store must not fail the migration itself.
    }

    if (migrated > 0) {
      console.info(`[storage-migration] Copied ${migrated} packetade:* keys to packetbench:*`);
    } else {
      // Say the quiet part. Reporting success by silence is the specific
      // failure mode this branch exists to remove.
      console.info(
        "[storage-migration] No packetade:* keys were present in this origin; " +
          "nothing to migrate. On a packaged upgrade this is expected — the old " +
          "bundle identifier is a different WebView2 profile and is not readable " +
          "from here.",
      );
    }
    return { status: "ran", record };
  } catch (e) {
    console.warn("[storage-migration] migration failed", e);
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
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
