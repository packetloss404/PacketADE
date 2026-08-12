import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";
import {
  forgetSyndicateMachine,
  pairSyndicateMachine,
  revokeSyndicateMachine,
  syndicateMachineSnapshot,
  syndicateWorkspaceCreate,
  syndicateWorkspaceList,
} from "@/lib/tauri";
import {
  parseMachineSnapshot,
  parseWorkspaceCatalog,
  parseWorkspaceCreate,
  syndicateConnection,
  type SyndicateMachine,
  type SyndicateWorkspaceCatalog,
  type SyndicateWorkspaceSnapshot,
} from "@/types/syndicate";

const MACHINES_KEY = storageKey("syndicate-machines-v1");

interface SyndicateStore {
  machines: SyndicateMachine[];
  connectionErrors: Record<string, string | undefined>;
  workspaceCache: Record<string, SyndicateWorkspaceSnapshot[]>;
  catalogCache: Record<string, SyndicateWorkspaceCatalog>;
  pair: (
    pairingPayload: string,
    deviceName: string,
    serverConfigId: string,
    relayEndpoint?: string,
  ) => Promise<SyndicateMachine>;
  refresh: (machineId: string) => Promise<void>;
  loadCatalog: (machineId: string) => Promise<SyndicateWorkspaceCatalog>;
  createHostWorkspace: (
    machineId: string,
    repositoryId: string,
    name: string,
    clientOperationId: string,
  ) => Promise<SyndicateWorkspaceSnapshot>;
  revoke: (machineId: string) => Promise<void>;
  forgetOffline: (machineId: string) => Promise<void>;
  getMachine: (machineId: string) => SyndicateMachine | undefined;
}

function loadMachines(): SyndicateMachine[] {
  const raw = loadFromStorage<unknown>(MACHINES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is SyndicateMachine => {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<SyndicateMachine>;
    return (
      typeof item.machineId === "string" &&
      typeof item.displayName === "string" &&
      typeof item.deviceId === "string" &&
      typeof item.serverConfigId === "string" &&
      typeof item.localPort === "number" &&
      typeof item.machineSigningFingerprint === "string" &&
      Array.isArray(item.scopes)
    );
  });
}

function persist(machines: SyndicateMachine[]) {
  saveToStorage(MACHINES_KEY, machines);
}

export const useSyndicateStore = create<SyndicateStore>((set, get) => ({
  machines: loadMachines(),
  connectionErrors: {},
  workspaceCache: {},
  catalogCache: {},

  pair: async (pairingPayload, deviceName, serverConfigId, relayEndpoint) => {
    // Credentials are intentionally one keychain record per Host machine in
    // v1. Never overwrite the only key capable of revoking an existing grant.
    if (get().machines.length > 0) {
      try {
        const raw = pairingPayload.trim().startsWith("syndicate-pair-v1:")
          ? atob(
              pairingPayload
                .trim()
                .slice("syndicate-pair-v1:".length)
                .replace(/-/g, "+")
                .replace(/_/g, "/"),
            )
          : pairingPayload;
        const machineId = (JSON.parse(raw) as { invitation?: { machineId?: unknown } }).invitation
          ?.machineId;
        if (
          typeof machineId === "string" &&
          get().machines.some((machine) => machine.machineId === machineId)
        ) {
          throw new Error(
            "This Syndicate machine is already paired. Revoke it, or explicitly forget the offline device, before pairing a replacement so its existing grant remains revocable.",
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("already paired")) throw error;
        // Native parsing remains authoritative for malformed or encoded payloads.
      }
    }
    const result = await pairSyndicateMachine(
      pairingPayload,
      deviceName,
      serverConfigId,
      relayEndpoint,
    );
    const machine: SyndicateMachine = {
      machineId: result.machineId,
      displayName: result.machineName,
      deviceId: result.deviceId,
      serverConfigId: result.serverConfigId,
      localPort: result.localPort,
      relayEndpoint: result.relayEndpoint,
      hostFingerprint: result.hostFingerprint,
      machineSigningFingerprint: result.machineSigningFingerprint,
      machineKeyAgreementFingerprint: result.machineKeyAgreementFingerprint,
      grantStatus: result.grantStatus,
      scopes: result.scopes,
      addedAt: Date.now(),
    };
    set((state) => {
      const machines = [machine, ...state.machines.filter((item) => item.machineId !== machine.machineId)];
      persist(machines);
      return { machines };
    });
    return machine;
  },

  refresh: async (machineId) => {
    const machine = get().machines.find((item) => item.machineId === machineId);
    if (!machine) throw new Error("Syndicate machine is no longer configured");
    try {
      const response = await syndicateMachineSnapshot(syndicateConnection(machine));
      const snapshot = parseMachineSnapshot(response.result);
      if (snapshot.machine.machineId !== machine.machineId) {
        throw new Error("Syndicate machine identity does not match the paired target");
      }
      if (snapshot.controller.device.deviceId !== machine.deviceId) {
        throw new Error("Syndicate device identity does not match the paired credential");
      }
      set((state) => {
        const machines = state.machines.map((item) =>
          item.machineId === machineId
            ? {
                ...item,
                displayName: snapshot.machine.displayName,
                grantStatus: "active" as const,
                scopes: snapshot.controller.device.scopes,
                cachedSnapshot: snapshot,
                lastConnectedAt: Date.now(),
              }
            : item,
        );
        persist(machines);
        return {
          machines,
          connectionErrors: { ...state.connectionErrors, [machineId]: undefined },
        };
      });
    } catch (error) {
      set((state) => ({
        connectionErrors: {
          ...state.connectionErrors,
          [machineId]: error instanceof Error ? error.message : String(error),
        },
      }));
      throw error;
    }
  },

  loadCatalog: async (machineId) => {
    const machine = get().machines.find((item) => item.machineId === machineId);
    if (!machine) throw new Error("Syndicate machine is no longer configured");
    const response = await syndicateWorkspaceList(syndicateConnection(machine));
    const catalog = parseWorkspaceCatalog(response.result);
    set((state) => ({
      workspaceCache: { ...state.workspaceCache, [machineId]: catalog.workspaces },
      catalogCache: { ...state.catalogCache, [machineId]: catalog },
    }));
    return catalog;
  },

  createHostWorkspace: async (machineId, repositoryId, name, clientOperationId) => {
    const machine = get().machines.find((item) => item.machineId === machineId);
    if (!machine) throw new Error("Syndicate machine is no longer configured");
    const response = await syndicateWorkspaceCreate({
      connection: syndicateConnection(machine),
      repositoryId,
      name,
      clientOperationId,
    });
    const workspace = parseWorkspaceCreate(response.result);
    set((state) => {
      const existing = state.workspaceCache[machineId] ?? [];
      const workspaces = [
        workspace,
        ...existing.filter((candidate) => candidate.workspaceId !== workspace.workspaceId),
      ];
      const priorCatalog = state.catalogCache[machineId];
      return {
        workspaceCache: { ...state.workspaceCache, [machineId]: workspaces },
        catalogCache: priorCatalog
          ? {
              ...state.catalogCache,
              [machineId]: { ...priorCatalog, workspaces },
            }
          : state.catalogCache,
      };
    });
    return workspace;
  },

  revoke: async (machineId) => {
    const machine = get().machines.find((item) => item.machineId === machineId);
    if (!machine) return;
    await revokeSyndicateMachine(syndicateConnection(machine));
    await forgetSyndicateMachine(machine.machineId);
    set((state) => {
      const machines = state.machines.filter((item) => item.machineId !== machineId);
      persist(machines);
      return { machines };
    });
  },

  forgetOffline: async (machineId) => {
    await forgetSyndicateMachine(machineId);
    set((state) => {
      const machines = state.machines.filter((item) => item.machineId !== machineId);
      persist(machines);
      return { machines };
    });
  },

  getMachine: (machineId) => get().machines.find((item) => item.machineId === machineId),
}));
