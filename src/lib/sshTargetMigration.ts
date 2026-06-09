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
 * legacy record whose id already exists in `serverStore.servers`. Legacy
 * localStorage keys are removed only after the merged `serverStore` slice
 * has been confirmed by the backend save call.
 */

import { useServerStore } from "@/stores/serverStore";
import type { ServerConfig } from "@/types/server";
import { loadFromStorage, removeFromStorage } from "@/lib/storage";
import { logSwallowed } from "@/lib/logSwallowed";
import { getSshPasswordExists, saveServersSlice } from "@/lib/tauri";

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
  authMethod?: "agent" | "key" | "password";
}

function loadLegacyTargets(): LegacySshTarget[] {
  const seen = new Set<string>();
  const merged: LegacySshTarget[] = [];

  for (const target of [
    ...loadFromStorage<LegacySshTarget[]>(LEGACY_STORAGE_KEY, []),
    ...loadFromStorage<LegacySshTarget[]>(LEGACY_PACKETCODE_KEY, []),
  ]) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    merged.push(target);
  }

  return merged;
}

export interface SshTargetMigrationResult {
  migrated: number;
  skipped: number;
}

async function inferAuthMethod(t: LegacySshTarget): Promise<ServerConfig["authMethod"]> {
  if (t.keyPath) return "key";
  if (t.authMethod === "password") return "password";
  if (t.authMethod === "agent") return "agent";

  try {
    return (await getSshPasswordExists(t.id)) ? "password" : "agent";
  } catch (e) {
    logSwallowed("sshTargetMigration.getSshPasswordExists")(e);
    return "agent";
  }
}

async function runSshTargetMigration(): Promise<SshTargetMigrationResult> {
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
      authMethod: await inferAuthMethod(t),
      keyPath: t.keyPath,
      remotePath: t.remotePath,
      lastConnectedAt: t.lastUsed ?? undefined,
      installedAgents: [],
      hostFingerprint: t.hostFingerprint,
    });
    existingIds.add(t.id);
  }

  const latestServers = useServerStore.getState().servers;
  const latestIds = new Set(latestServers.map((s) => s.id));
  const dedupedToAdd = toAdd.filter((server) => {
    if (latestIds.has(server.id)) {
      skipped++;
      return false;
    }
    latestIds.add(server.id);
    return true;
  });
  const mergedServers =
    dedupedToAdd.length > 0 ? [...latestServers, ...dedupedToAdd] : latestServers;

  if (legacy.length > 0) {
    try {
      await saveServersSlice(mergedServers);
    } catch (e) {
      logSwallowed("sshTargetMigration.saveServers")(e);
      return { migrated: dedupedToAdd.length, skipped };
    }
  }

  if (dedupedToAdd.length > 0) {
    // Use a single set() so we only emit one serverStore notification and
    // avoid triggering one backend save per migrated row. The save above is
    // already confirmed, so this in-memory update won't orphan legacy data.
    useServerStore.setState((s) => {
      const currentIds = new Set(s.servers.map((server) => server.id));
      const additions = dedupedToAdd.filter((server) => !currentIds.has(server.id));
      return additions.length > 0 ? { servers: [...s.servers, ...additions] } : s;
    });
  }

  // Clear the legacy keys so the migration never runs again.
  removeFromStorage(LEGACY_STORAGE_KEY);
  removeFromStorage(LEGACY_PACKETCODE_KEY);

  console.info(
    `[ssh-migration] migrated ${dedupedToAdd.length} legacy SshTarget(s) to serverStore (skipped ${skipped} duplicates)`,
  );

  return { migrated: dedupedToAdd.length, skipped };
}

export async function migrateSshTargetsToServers(): Promise<SshTargetMigrationResult> {
  try {
    return await runSshTargetMigration();
  } catch (e) {
    logSwallowed("sshTargetMigration")(e);
    return { migrated: 0, skipped: 0 };
  }
}
