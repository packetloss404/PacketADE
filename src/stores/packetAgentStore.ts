import { create } from "zustand";
import { persist } from "zustand/middleware";
import { storageKey } from "@/lib/brand";
import { packetAgentRequest } from "@/lib/tauri";
import type {
  PacketAgentDeploymentProjection,
  PacketAgentResponse,
  PacketAgentWorkerPackage,
} from "@/types/packet-agent";

interface PacketAgentStore {
  endpoint: string;
  workspaceId: string;
  deployments: Record<string, PacketAgentDeploymentProjection>;
  setConnection: (endpoint: string, workspaceId: string) => void;
  removeDeployment: (flightId: string) => void;
  updateProjection: (flightId: string, updates: Partial<PacketAgentDeploymentProjection>) => void;
  request: (
    operation: Parameters<typeof packetAgentRequest>[0]["operation"],
    options?: Omit<
      Parameters<typeof packetAgentRequest>[0],
      "endpoint" | "workspaceId" | "operation"
    >,
  ) => Promise<PacketAgentResponse>;
  recordDeployment: (
    flightId: string,
    workerPackage: PacketAgentWorkerPackage,
    response: PacketAgentResponse,
  ) => PacketAgentDeploymentProjection;
  mergeProjection: (
    flightId: string,
    response: PacketAgentResponse,
  ) => PacketAgentDeploymentProjection | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  const found = record(value)?.[key];
  return typeof found === "string" ? found : undefined;
}

function numberAt(value: unknown, key: string): number | undefined {
  const found = record(value)?.[key];
  return typeof found === "number" ? found : undefined;
}

function deploymentFields(body: Record<string, unknown>) {
  const deployment = record(body.deployment) ?? record(body.control);
  const resultingIds = record(body.resultingIds);
  return {
    deploymentId:
      stringAt(resultingIds, "workerDeploymentId") ??
      stringAt(deployment, "workerDeploymentId") ??
      stringAt(deployment, "id"),
    workerRunId:
      stringAt(resultingIds, "workerRunId") ?? stringAt(record(body.activation), "workerRunId"),
    revision: numberAt(deployment, "revision"),
    status: stringAt(deployment, "status"),
  };
}

export const usePacketAgentStore = create<PacketAgentStore>()(
  persist(
    (set, get) => ({
      endpoint: "http://127.0.0.1:8787",
      workspaceId: "",
      deployments: {},
      setConnection: (endpoint, workspaceId) =>
        set({ endpoint: endpoint.trim().replace(/\/+$/, ""), workspaceId: workspaceId.trim() }),
      removeDeployment: (flightId) =>
        set((state) => {
          const deployments = { ...state.deployments };
          delete deployments[flightId];
          return { deployments };
        }),
      updateProjection: (flightId, updates) =>
        set((state) => {
          const current = state.deployments[flightId];
          if (!current) return {};
          return {
            deployments: {
              ...state.deployments,
              [flightId]: { ...current, ...updates, updatedAt: Date.now() },
            },
          };
        }),
      request: (operation, options = {}) => {
        const { endpoint, workspaceId } = get();
        return packetAgentRequest({ endpoint, workspaceId, operation, ...options });
      },
      recordDeployment: (flightId, workerPackage, response) => {
        const fields = deploymentFields(response.body);
        if (!fields.deploymentId) {
          throw new Error("PacketAgent response did not include a worker deployment ID.");
        }
        const projection: PacketAgentDeploymentProjection = {
          flightId,
          packageId: workerPackage.packageId,
          packageVersion: workerPackage.packageVersion,
          packageDigest: workerPackage.integrity.digest,
          deploymentId: fields.deploymentId,
          workerRunId: fields.workerRunId,
          revision: fields.revision ?? 1,
          status: fields.status ?? "deployed",
          attentionCount: 0,
          evidenceEventIds: [],
          updatedAt: Date.now(),
        };
        set((state) => ({
          deployments: { ...state.deployments, [flightId]: projection },
        }));
        return projection;
      },
      mergeProjection: (flightId, response) => {
        const current = get().deployments[flightId];
        if (!current) return undefined;
        const fields = deploymentFields(response.body);
        const next: PacketAgentDeploymentProjection = {
          ...current,
          ...(fields.deploymentId ? { deploymentId: fields.deploymentId } : {}),
          ...(fields.workerRunId ? { workerRunId: fields.workerRunId } : {}),
          ...(fields.revision ? { revision: fields.revision } : {}),
          ...(fields.status ? { status: fields.status } : {}),
          updatedAt: Date.now(),
        };
        set((state) => ({ deployments: { ...state.deployments, [flightId]: next } }));
        return next;
      },
    }),
    {
      name: storageKey("packet-agent"),
      partialize: ({ endpoint, workspaceId, deployments }) => ({
        endpoint,
        workspaceId,
        deployments,
      }),
    },
  ),
);
