/**
 * Phase 2: one-time migration of legacy `SshTarget` records (persisted
 * under `packetade:ssh-targets` in localStorage) into the unified
 * `serverStore`. The two stacks both modeled "an SSH endpoint"; the only
 * meaningful difference was that `SshTarget.remotePath` was a single
 * required field, whereas `ServerConfig.remotePath` is optional and acts
 * as a per-server default that the Agents pane overrides per-conversation.
 *
 * IDs are preserved so any persisted `AgentConversation.sshTarget.id`
 * references survive the move. The migration is idempotent: it skips any
 * legacy record whose id already exists in `serverStore.servers`, removes
 * the legacy localStorage key on completion, and logs the count.
 */

import { useServerStore } from "@/stores/serverStore";
import type { ServerConfig } from "@/types/server";
import { loadFromStorage, removeFromStorage } from "@/lib/storage";
import { logSwallowed } from "@/lib/logSwallowed";

const LEGACY_STORAGE_KEY = "packetade:ssh-targets";
// Older builds used the pre-rename prefix; check both for safety.
const LEGACY_PACKETCODE_KEY = "packetcode:ssh-targets";

interface LegacySshTarget {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  remotePath: string;
  keyPath?: string;
  createdAt?: number;
  lastUsed?: number | null;
  hostFingerprint?: string;
}

function loadLegacyTargets(): LegacySshTarget[] {
  const fromPackdade = loadFromStorage<LegacySshTarget[]>(LEGACY_STORAGE_KEY, []);
  if (fromPackdade.length > 0) return fromPackdade;
  return loadFromStorage<LegacySshTarget[]>(LEGACY_PACKETCODE_KEY, []);
}

export function migrateSshTargetsToServers(): { migrated: number; skipped: number } {
  const legacy = loadLegacyTargets();
  if (legacy.length === 0) {
    // Nothing to do — but still scrub any empty array left behind.
    removeFromStorage(LEGACY_STORAGE_KEY);
    removeFromStorage(LEGACY_PACKETCODE_KEY);
    return { migrated: 0, skipped: 0 };
  }

  const store = useServerStore.getState();
  const existingIds = new Set(store.servers.map((s) => s.id));

  const toAdd: ServerConfig[] = [];
  let skipped = 0;
  for (const t of legacy) {
    if (!t || !t.id || existingIds.has(t.id)) {
      skipped++;
      continue;
    }
    toAdd.push({
      id: t.id,
      name: t.name || `${t.user}@${t.host}`,
      host: t.host,
      port: typeof t.port === "number" ? t.port : 22,
      username: t.user,
      // SshTarget had keyPath OR password-via-keyring; default to key-based
      // when we have a key, otherwise fall back to the OS ssh-agent.
      authMethod: t.keyPath ? "key" : "agent",
      keyPath: t.keyPath,
      remotePath: t.remotePath,
      lastConnectedAt: t.lastUsed ?? undefined,
      installedAgents: [],
      hostFingerprint: t.hostFingerprint,
    });
    existingIds.add(t.id);
  }

  if (toAdd.length > 0) {
    // Use a single set() so we only emit one serverStore notification and
    // sync to backend once. updateServer/addServer would also work but
    // each one persists via saveServersSlice — wasteful for a batch.
    useServerStore.setState((s) => ({
      servers: [...s.servers, ...toAdd],
    }));
    // Re-trigger backend sync now that the merged list is settled.
    // Use updateServer on the first migrated row to nudge syncToBackend —
    // or just call hydrateFromBackend which is read-only. Instead, prefer
    // a direct save: the addServer path uses syncToBackend internally, but
    // calling it via setState above bypassed that. Re-fetch and persist.
    try {
      // Lazy import keeps bootstrap.ts free of the tauri sync wiring.
      void import("@/lib/tauri").then(({ saveServersSlice }) =>
        saveServersSlice(useServerStore.getState().servers).catch(
          logSwallowed("sshTargetMigration.saveServers"),
        ),
      );
    } catch {
      // ignore — backend will catch up on the next add/update.
    }
  }

  // Clear the legacy keys so the migration never runs again.
  removeFromStorage(LEGACY_STORAGE_KEY);
  removeFromStorage(LEGACY_PACKETCODE_KEY);

  console.info(
    `[ssh-migration] migrated ${toAdd.length} legacy SshTarget(s) to serverStore (skipped ${skipped} duplicates)`,
  );

  return { migrated: toAdd.length, skipped };
}
