/**
 * The one ordered boot sequence for everything that must touch `localStorage`
 * **before a single store module evaluates**.
 *
 * Zustand stores in this app hydrate synchronously at module-evaluation time,
 * so anything that repairs or repopulates `localStorage` has to finish before
 * those modules are imported. This module owns that ordering; `main.tsx` awaits
 * it and only then dynamically imports the React tree.
 *
 * That dynamic import is load-bearing and replaces the previous
 * `run-storage-migration.ts` side-effect-import trick. A bare `await` in
 * `main.tsx` is not enough — ESM hoists static imports, so `App`'s entire
 * module graph (and with it every store) evaluates before `main.tsx`'s body
 * runs. A top-level `await` in an eagerly-imported module does not help
 * either: per spec, an async module does not block evaluation of its *sibling*
 * imports, only of the importing module's own body. Deferring the import until
 * after the boot promise settles is the only ordering that actually holds.
 *
 * Order matters within the sequence too:
 *
 * 1. {@link bootStorageMirror} first, because on a fresh bundle identifier the
 *    store is empty and there is nothing for the later steps to migrate until
 *    the mirror has refilled it — including the migration guard keys, so a
 *    restored install correctly skips migrations it already ran.
 * 2. `migrateLegacyStorage` — copy any surviving `packetade:*` keys forward.
 * 3. `migrateIssuesMissionToFlight` — canonicalize `missionId` on the issues
 *    blob that step 2 may have just put in place.
 */

import { MONITOR_WINDOW_QUERY_KEY } from "@/lib/brand";
import {
  migrateIssuesMissionToFlight,
  migrateLegacyStorage,
  type LegacyMigrationOutcome,
} from "@/lib/storage-migration";
import { bootStorageMirror, type StorageMirrorBootResult } from "@/lib/storageMirror";

/**
 * Whether this webview is a read-only Monitor window.
 *
 * Intentionally duplicated from `isMonitorBoot()` in `@/lib/monitorWindows`
 * rather than imported: that module pulls in `appStore`, `flightStore` and
 * `sessionGlue`, and importing it here would evaluate those stores — hydrating
 * them from `localStorage` — before the restore this file exists to run.
 */
function isMonitorWindow(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return (
      new URLSearchParams(window.location.search).get(MONITOR_WINDOW_QUERY_KEY) === "monitor"
    );
  } catch {
    return false;
  }
}

/**
 * What this launch's storage boot did. Kept so a diagnostics surface can show
 * it: `bootPersistedStorage` runs before React exists, so returning the result
 * to `main.tsx` alone would put it out of reach of every consumer that wants
 * it — the same "typed contract, no reader" shape that hid the PTY exit
 * payload for months.
 */
export interface StorageBootRecord {
  /** Epoch ms the boot sequence completed. */
  at: number;
  /** Durable-mirror restore outcome. */
  mirror: StorageMirrorBootResult;
  /** What the `packetade:*` migrator saw, this launch or a previous one. */
  legacy: LegacyMigrationOutcome;
  /** True in a Monitor window, which deliberately skips the mirror entirely. */
  monitorWindow: boolean;
}

let lastBoot: StorageBootRecord | null = null;

/**
 * The most recent {@link bootPersistedStorage} result, or `null` if it has not
 * run in this webview. Safe to call during render: `main.tsx` awaits the boot
 * before it imports the React tree.
 */
export function getStorageBootRecord(): StorageBootRecord | null {
  return lastBoot;
}

/** Test seam — clears the captured record. */
export function resetStorageBootRecord(): void {
  lastBoot = null;
}

/**
 * Run every pre-hydration storage step. Never rejects: a boot that cannot
 * repair storage must still start the app.
 */
export async function bootPersistedStorage(): Promise<StorageBootRecord> {
  let mirror: StorageMirrorBootResult = { active: false, restored: 0, reason: "no-tauri" };
  const monitorWindow = isMonitorWindow();

  try {
    // A Monitor window shares the main window's origin, so its `localStorage`
    // is already populated and there is nothing to restore. Keeping the writer
    // out of it also avoids two windows flushing the same snapshot.
    if (!monitorWindow) {
      mirror = await bootStorageMirror();
    }
  } catch (e) {
    console.warn("[storage-boot] storage mirror boot failed", e);
  }

  let legacy: LegacyMigrationOutcome;
  try {
    legacy = migrateLegacyStorage();
    migrateIssuesMissionToFlight();
  } catch (e) {
    console.warn("[storage-boot] legacy storage migration failed", e);
    legacy = { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }

  lastBoot = { at: Date.now(), mirror, legacy, monitorWindow };
  return lastBoot;
}
