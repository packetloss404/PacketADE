/**
 * What the user has *asked for* regarding Remote Agents. Not authorization.
 *
 * Read `src/lib/remoteAgentsGate.ts` before using anything here. That module is
 * the seam that decides whether Remote Agents may actually run; this store is
 * only one of its two inputs. Importing this store from anywhere else is an
 * eslint error (`eslint.config.js`), because a bare truthy check on a user
 * preference is exactly how a fail-closed feature becomes fail-open.
 *
 * The state field is deliberately named `requested`, not `enabled`. The
 * persisted JSON keeps its original `{ remoteAgents: { enabled } }` shape so no
 * migration is needed — the rename is in memory only, where the mistake would
 * be made.
 */

import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";

export const REMOTE_AGENTS_SETTINGS_KEY = storageKey("remote-agents");

export interface RemoteAgentsFeatureSettings {
  enabled: boolean;
}

interface RemoteAgentsSettingsStore {
  /** User intent only. Ask `isRemoteAgentsEnabled()` whether it may run. */
  requested: RemoteAgentsFeatureSettings;
  setRequestedEnabled: (enabled: boolean) => void;
}

const DEFAULTS: RemoteAgentsFeatureSettings = { enabled: false };

export function parseRemoteAgentsSettings(input: unknown): RemoteAgentsFeatureSettings {
  if (
    typeof input === "object" &&
    input !== null &&
    "remoteAgents" in input &&
    typeof input.remoteAgents === "object" &&
    input.remoteAgents !== null &&
    "enabled" in input.remoteAgents &&
    typeof input.remoteAgents.enabled === "boolean"
  ) {
    return { enabled: input.remoteAgents.enabled };
  }
  return DEFAULTS;
}

function load(): RemoteAgentsFeatureSettings {
  const raw = loadFromStorage<unknown>(REMOTE_AGENTS_SETTINGS_KEY, {});
  return parseRemoteAgentsSettings(raw);
}

export const useRemoteAgentsSettingsStore = create<RemoteAgentsSettingsStore>((set) => ({
  requested: load(),
  setRequestedEnabled: (enabled) =>
    set(() => {
      const remoteAgents = { enabled };
      saveToStorage(REMOTE_AGENTS_SETTINGS_KEY, { remoteAgents });
      return { requested: remoteAgents };
    }),
}));
