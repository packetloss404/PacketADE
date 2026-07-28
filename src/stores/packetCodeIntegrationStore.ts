import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";

const STORAGE_KEY = storageKey("packetcode-integration");

export type PacketCodeReleaseChannel = "stable" | "preview";

interface PacketCodeIntegrationSettings {
  localDataHome: string;
  developerRepoPath: string;
  releaseChannel: PacketCodeReleaseChannel;
  remoteDataHomes: Record<string, string>;
}

interface PacketCodeIntegrationStore extends PacketCodeIntegrationSettings {
  setLocalDataHome: (path: string) => void;
  setDeveloperRepoPath: (path: string) => void;
  setReleaseChannel: (channel: PacketCodeReleaseChannel) => void;
  setRemoteDataHome: (serverId: string, path: string) => void;
}

const DEFAULTS: PacketCodeIntegrationSettings = {
  localDataHome: "",
  developerRepoPath: "",
  releaseChannel: "stable",
  remoteDataHomes: {},
};

function load(): PacketCodeIntegrationSettings {
  const raw = loadFromStorage<Partial<PacketCodeIntegrationSettings>>(STORAGE_KEY, DEFAULTS);
  return {
    localDataHome: typeof raw.localDataHome === "string" ? raw.localDataHome : "",
    developerRepoPath:
      typeof raw.developerRepoPath === "string" ? raw.developerRepoPath : "",
    releaseChannel: raw.releaseChannel === "preview" ? "preview" : "stable",
    remoteDataHomes:
      raw.remoteDataHomes && typeof raw.remoteDataHomes === "object"
        ? Object.fromEntries(
            Object.entries(raw.remoteDataHomes).filter(
              ([serverId, path]) =>
                serverId.trim().length > 0 && typeof path === "string",
            ),
          )
        : {},
  };
}

function persist(settings: PacketCodeIntegrationSettings) {
  saveToStorage(STORAGE_KEY, settings);
}

export function isAbsolutePacketCodePath(
  path: string,
  platform: "windows" | "posix" | "either" = "either",
): boolean {
  const trimmed = path.trim();
  const windows =
    /^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\[^\\]+\\[^\\]+/.test(trimmed);
  const posix = trimmed.startsWith("/");
  if (platform === "windows") return windows;
  if (platform === "posix") return posix;
  return windows || posix;
}

export const usePacketCodeIntegrationStore = create<PacketCodeIntegrationStore>((set) => ({
  ...load(),

  setLocalDataHome: (path) =>
    set((state) => {
      const next = { ...state, localDataHome: path };
      const settings = pickSettings(next);
      persist(settings);
      return settings;
    }),

  setDeveloperRepoPath: (path) =>
    set((state) => {
      const next = { ...state, developerRepoPath: path };
      const settings = pickSettings(next);
      persist(settings);
      return settings;
    }),

  setReleaseChannel: (releaseChannel) =>
    set((state) => {
      const next = { ...state, releaseChannel };
      const settings = pickSettings(next);
      persist(settings);
      return settings;
    }),

  setRemoteDataHome: (serverId, path) =>
    set((state) => {
      if (!serverId.trim()) return state;
      const remoteDataHomes = { ...state.remoteDataHomes };
      if (path.trim()) {
        remoteDataHomes[serverId] = path;
      } else {
        delete remoteDataHomes[serverId];
      }
      const settings = pickSettings({ ...state, remoteDataHomes });
      persist(settings);
      return settings;
    }),
}));

function pickSettings(state: PacketCodeIntegrationSettings): PacketCodeIntegrationSettings {
  return {
    localDataHome: state.localDataHome,
    developerRepoPath: state.developerRepoPath,
    releaseChannel: state.releaseChannel,
    remoteDataHomes: state.remoteDataHomes,
  };
}
