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
import { migrateIssuesMissionToFlight, migrateLegacyStorage } from "@/lib/storage-migration";
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
 * Run every pre-hydration storage step. Never rejects: a boot that cannot
 * repair storage must still start the app.
 */
export async function bootPersistedStorage(): Promise<StorageMirrorBootResult> {
  let mirror: StorageMirrorBootResult = { active: false, restored: 0, reason: "no-tauri" };

  try {
    // A Monitor window shares the main window's origin, so its `localStorage`
    // is already populated and there is nothing to restore. Keeping the writer
    // out of it also avoids two windows flushing the same snapshot.
    if (!isMonitorWindow()) {
      mirror = await bootStorageMirror();
    }
  } catch (e) {
    console.warn("[storage-boot] storage mirror boot failed", e);
  }

  try {
    migrateLegacyStorage();
    migrateIssuesMissionToFlight();
  } catch (e) {
    console.warn("[storage-boot] legacy storage migration failed", e);
  }

  return mirror;
}
