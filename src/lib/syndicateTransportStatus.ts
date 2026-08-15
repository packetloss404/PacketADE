import { storageKey } from "@/lib/brand";
import type { SyndicateTransport } from "@/types/syndicate";

export interface SyndicateTransportObservation {
  transport: SyndicateTransport;
  observedAt: number;
}

type TransportSnapshot = Record<string, SyndicateTransportObservation | undefined>;

const STORAGE_KEY = storageKey("syndicate-transport-status-v1");
const observationKey = (machineId: string, deviceId: string) => `${machineId}\n${deviceId}`;

function loadSnapshot(): TransportSnapshot {
  if (typeof localStorage === "undefined") return {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, candidate]) => {
        if (!candidate || typeof candidate !== "object") return [];
        const raw = candidate as Record<string, unknown>;
        if (
          (raw.transport !== "packet-relay" && raw.transport !== "ssh-forward") ||
          typeof raw.observedAt !== "number" ||
          !Number.isFinite(raw.observedAt)
        ) {
          return [];
        }
        return [[key, { transport: raw.transport, observedAt: raw.observedAt }]];
      }),
    );
  } catch {
    return {};
  }
}

let snapshot: TransportSnapshot = loadSnapshot();
const listeners = new Set<() => void>();

/**
 * Minimum spacing between writes for an unchanged transport.
 *
 * Every successful RPC reports its carrier, and an active pane polls output
 * every 25 ms and sends one `session.input` per keystroke — roughly 40 writes
 * a second, each a synchronous `JSON.stringify` plus `localStorage.setItem`
 * plus a re-render of the machines card, all to move a timestamp nobody reads
 * at that resolution. A change of carrier is still recorded immediately,
 * because that is the part users act on.
 */
const UNCHANGED_TRANSPORT_WRITE_INTERVAL_MS = 30_000;

function persist() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // The in-memory observation remains useful for this launch.
  }
}

export function getSyndicateTransportSnapshot(): TransportSnapshot {
  return snapshot;
}

export function subscribeSyndicateTransportSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordSyndicateTransport(
  machineId: string,
  deviceId: string,
  transport: SyndicateTransport,
  observedAt = Date.now(),
): void {
  const key = observationKey(machineId, deviceId);
  const previous = snapshot[key];
  if (
    previous &&
    previous.transport === transport &&
    observedAt - previous.observedAt < UNCHANGED_TRANSPORT_WRITE_INTERVAL_MS
  ) {
    return;
  }
  snapshot = { ...snapshot, [key]: { transport, observedAt } };
  persist();
  for (const listener of listeners) listener();
}

export function forgetSyndicateTransport(machineId: string): void {
  const prefix = `${machineId}\n`;
  if (!Object.keys(snapshot).some((key) => key.startsWith(prefix))) return;
  snapshot = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => !key.startsWith(prefix)),
  );
  persist();
  for (const listener of listeners) listener();
}

export function syndicateTransportObservation(
  state: TransportSnapshot,
  machineId: string,
  deviceId: string,
): SyndicateTransportObservation | undefined {
  return state[observationKey(machineId, deviceId)];
}
