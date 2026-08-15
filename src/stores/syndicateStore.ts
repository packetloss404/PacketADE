import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";
import {
  disableSyndicateIntegration,
  forgetSyndicateMachine,
  pairSyndicateMachine,
  revokeSyndicateMachine,
  syndicateMachineSnapshot,
  syndicateWorkspaceCreate,
  syndicateWorkspaceList,
  setNativeSyndicateIntegrationEnabled,
} from "@/lib/tauri";
import {
  grantExpiryFromSnapshot,
  parseMachineSnapshot,
  parseWorkspaceCatalog,
  parseWorkspaceCreate,
  syndicateConnection,
  type SyndicateGrantStatus,
  type SyndicateMachine,
  type SyndicateWorkspaceCatalog,
  type SyndicateWorkspaceSnapshot,
} from "@/types/syndicate";
import { grantStatusFromSyndicateError } from "@/lib/syndicateErrors";
import {
  loadSyndicateIntegrationEnabled,
  persistSyndicateIntegrationEnabled,
  SYNDICATE_INTEGRATION_DISABLED_MESSAGE,
} from "@/lib/syndicateIntegration";

const MACHINES_KEY = storageKey("syndicate-machines-v1");

interface SyndicateStore {
  enabled: boolean;
  /** Native command boundary has applied the persisted preference. */
  nativeReady: boolean;
  nativeSyncError?: string;
  /** Invalidates late controller reads when the integration changes state. */
  operationGeneration: number;
  machines: SyndicateMachine[];
  connectionErrors: Record<string, string | undefined>;
  workspaceCache: Record<string, SyndicateWorkspaceSnapshot[]>;
  catalogCache: Record<string, SyndicateWorkspaceCatalog>;
  setEnabled: (enabled: boolean) => Promise<void>;
  syncNative: () => Promise<void>;
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
  recordControllerFailure: (machineId: string, deviceId: string, error: unknown) => void;
  getMachine: (machineId: string) => SyndicateMachine | undefined;
}

const GRANT_STATUSES: readonly SyndicateGrantStatus[] = ["pending", "active", "revoked", "expired"];

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
      // An unrecognized status must not survive into the UI: `undefined` is
      // not "revoked", and the authority summary would read a dead grant as
      // "Full coding control".
      typeof item.grantStatus === "string" &&
      GRANT_STATUSES.includes(item.grantStatus) &&
      (item.grantExpiresAt === undefined || typeof item.grantExpiresAt === "number") &&
      Array.isArray(item.scopes) &&
      item.scopes.every((scope) => typeof scope === "string")
    );
  });
}

function persist(machines: SyndicateMachine[]) {
  saveToStorage(MACHINES_KEY, machines);
}

function hasCurrentDevice(
  state: Pick<SyndicateStore, "machines">,
  machineId: string,
  deviceId: string,
): boolean {
  return state.machines.some(
    (machine) => machine.machineId === machineId && machine.deviceId === deviceId,
  );
}

let preferenceTransition: Promise<void> = Promise.resolve();
let preferenceRevision = 0;
let requestedEnabled = loadSyndicateIntegrationEnabled();

export const useSyndicateStore = create<SyndicateStore>((set, get) => ({
  enabled: loadSyndicateIntegrationEnabled(),
  nativeReady: false,
  nativeSyncError: undefined,
  operationGeneration: 0,
  machines: loadMachines(),
  connectionErrors: {},
  workspaceCache: {},
  catalogCache: {},

  setEnabled: async (enabled) => {
    if (requestedEnabled === enabled && get().enabled === enabled && get().nativeReady) {
      return preferenceTransition;
    }
    requestedEnabled = enabled;
    const revision = ++preferenceRevision;

    // Close the frontend boundary immediately. Enabling is the inverse: the
    // native boundary must open successfully before mounted panes see true.
    if (!enabled) {
      persistSyndicateIntegrationEnabled(false);
      set((state) => ({
        enabled: false,
        operationGeneration: state.operationGeneration + 1,
      }));
    }

    preferenceTransition = preferenceTransition
      .catch(() => {})
      .then(async () => {
        if (revision !== preferenceRevision) return;
        try {
          if (enabled) await setNativeSyndicateIntegrationEnabled(true);
          else await disableSyndicateIntegration();
        } catch (error) {
          // Disable flips the native flag before tunnel cleanup, so even a
          // degraded cleanup result is a ready, fail-closed command boundary.
          set({
            nativeReady: !enabled,
            nativeSyncError: error instanceof Error ? error.message : String(error),
          });
          if (enabled && revision === preferenceRevision) requestedEnabled = get().enabled;
          throw error;
        }

        // A newer intent arrived while native work was in flight. If this was
        // a stale enable, close it again before yielding to the queued disable.
        if (revision !== preferenceRevision) {
          if (enabled) await disableSyndicateIntegration();
          return;
        }
        if (enabled) {
          persistSyndicateIntegrationEnabled(true);
          set((state) => ({
            enabled: true,
            nativeReady: true,
            nativeSyncError: undefined,
            operationGeneration: state.operationGeneration + 1,
          }));
        } else {
          set({ nativeReady: true, nativeSyncError: undefined });
        }
      });
    return preferenceTransition;
  },

  syncNative: async () => {
    requestedEnabled = get().enabled;
    const desiredEnabled = requestedEnabled;
    const revision = ++preferenceRevision;
    preferenceTransition = preferenceTransition
      .catch(() => {})
      .then(async () => {
        if (revision !== preferenceRevision) return;
        try {
          await setNativeSyndicateIntegrationEnabled(desiredEnabled);
          if (revision !== preferenceRevision) {
            if (desiredEnabled) await disableSyndicateIntegration();
            return;
          }
          set({ nativeReady: true, nativeSyncError: undefined });
        } catch (error) {
          if (revision === preferenceRevision) {
            set({
              nativeReady: !desiredEnabled,
              nativeSyncError: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
      });
    return preferenceTransition;
  },

  pair: async (pairingPayload, deviceName, serverConfigId, relayEndpoint) => {
    if (!get().enabled) throw new Error(SYNDICATE_INTEGRATION_DISABLED_MESSAGE);
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
      const machines = [
        machine,
        ...state.machines.filter((item) => item.machineId !== machine.machineId),
      ];
      persist(machines);
      return { machines, operationGeneration: state.operationGeneration + 1 };
    });
    return machine;
  },

  refresh: async (machineId) => {
    if (!get().enabled) throw new Error(SYNDICATE_INTEGRATION_DISABLED_MESSAGE);
    const machine = get().machines.find((item) => item.machineId === machineId);
    if (!machine) throw new Error("Syndicate machine is no longer configured");
    const generation = get().operationGeneration;
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
        if (
          !state.enabled ||
          state.operationGeneration !== generation ||
          !hasCurrentDevice(state, machineId, machine.deviceId)
        ) {
          return state;
        }
        const machines = state.machines.map((item) =>
          item.machineId === machineId
            ? {
                ...item,
                displayName: snapshot.machine.displayName,
                grantStatus: "active" as const,
                scopes: snapshot.controller.device.scopes,
                // Grants die at 30 days with no renewal path. Carrying the
                // Host's own expiry is what makes a warning possible before
                // the cliff rather than a diagnosis after it.
                grantExpiresAt: grantExpiryFromSnapshot(snapshot) ?? item.grantExpiresAt,
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
      set((state) => {
        if (
          !state.enabled ||
          state.operationGeneration !== generation ||
          !hasCurrentDevice(state, machineId, machine.deviceId)
        ) {
          return state;
        }
        const grantStatus = grantStatusFromSyndicateError(error);
        const machines = grantStatus
          ? state.machines.map((item) =>
              item.machineId === machineId && item.deviceId === machine.deviceId
                ? { ...item, grantStatus }
                : item,
            )
          : state.machines;
        if (grantStatus) persist(machines);
        return {
          machines,
          connectionErrors: {
            ...state.connectionErrors,
            [machineId]: error instanceof Error ? error.message : String(error),
          },
        };
      });
      throw error;
    }
  },

  loadCatalog: async (machineId) => {
    if (!get().enabled) throw new Error(SYNDICATE_INTEGRATION_DISABLED_MESSAGE);
    const machine = get().machines.find((item) => item.machineId === machineId);
    if (!machine) throw new Error("Syndicate machine is no longer configured");
    const generation = get().operationGeneration;
    // Every controller call is evidence about the grant, not just the terminal
    // poll. A dead grant discovered here used to be reported and then thrown
    // away, leaving the machines card claiming the device was still active.
    const response = await syndicateWorkspaceList(syndicateConnection(machine)).catch(
      (reason: unknown) => {
        get().recordControllerFailure(machineId, machine.deviceId, reason);
        throw reason;
      },
    );
    const catalog = parseWorkspaceCatalog(response.result);
    set((state) =>
      !state.enabled ||
      state.operationGeneration !== generation ||
      !hasCurrentDevice(state, machineId, machine.deviceId)
        ? state
        : {
            workspaceCache: { ...state.workspaceCache, [machineId]: catalog.workspaces },
            catalogCache: { ...state.catalogCache, [machineId]: catalog },
          },
    );
    return catalog;
  },

  createHostWorkspace: async (machineId, repositoryId, name, clientOperationId) => {
    if (!get().enabled) throw new Error(SYNDICATE_INTEGRATION_DISABLED_MESSAGE);
    const machine = get().machines.find((item) => item.machineId === machineId);
    if (!machine) throw new Error("Syndicate machine is no longer configured");
    const generation = get().operationGeneration;
    const response = await syndicateWorkspaceCreate({
      connection: syndicateConnection(machine),
      repositoryId,
      name,
      clientOperationId,
    }).catch((reason: unknown) => {
      get().recordControllerFailure(machineId, machine.deviceId, reason);
      throw reason;
    });
    const workspace = parseWorkspaceCreate(response.result);
    set((state) => {
      if (
        !state.enabled ||
        state.operationGeneration !== generation ||
        !hasCurrentDevice(state, machineId, machine.deviceId)
      ) {
        return state;
      }
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

  // Revocation and local cleanup deliberately ignore the Settings switch.
  // Disabling the integration is what a user does on suspicion of compromise;
  // if that also disarmed revocation, the grant would stay live on the Host
  // until it expired. These are the two operations that *reduce* authority.
  revoke: async (machineId) => {
    const machine = get().machines.find((item) => item.machineId === machineId);
    if (!machine) return;
    await revokeSyndicateMachine(syndicateConnection(machine));
    await forgetSyndicateMachine(machine.machineId);
    set((state) => {
      const machines = state.machines.filter((item) => item.machineId !== machineId);
      persist(machines);
      return { machines, operationGeneration: state.operationGeneration + 1 };
    });
  },

  forgetOffline: async (machineId) => {
    // Local-only: deletes the OS-keychain record and needs no transport at all.
    await forgetSyndicateMachine(machineId);
    set((state) => {
      const machines = state.machines.filter((item) => item.machineId !== machineId);
      persist(machines);
      return { machines, operationGeneration: state.operationGeneration + 1 };
    });
  },

  recordControllerFailure: (machineId, deviceId, error) => {
    const grantStatus = grantStatusFromSyndicateError(error);
    if (!grantStatus) return;
    set((state) => {
      if (!hasCurrentDevice(state, machineId, deviceId)) return state;
      const machines = state.machines.map((machine) =>
        machine.machineId === machineId && machine.deviceId === deviceId
          ? { ...machine, grantStatus }
          : machine,
      );
      persist(machines);
      return { machines };
    });
  },

  getMachine: (machineId) => get().machines.find((item) => item.machineId === machineId),
}));
