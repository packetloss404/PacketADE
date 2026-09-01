import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";

export const REMOTE_AGENTS_SETTINGS_KEY = storageKey("remote-agents");

export interface RemoteAgentsFeatureSettings {
  enabled: boolean;
}

interface RemoteAgentsSettingsStore {
  remoteAgents: RemoteAgentsFeatureSettings;
  setEnabled: (enabled: boolean) => void;
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
  remoteAgents: load(),
  setEnabled: (enabled) =>
    set(() => {
      const remoteAgents = { enabled };
      saveToStorage(REMOTE_AGENTS_SETTINGS_KEY, { remoteAgents });
      return { remoteAgents };
    }),
}));
