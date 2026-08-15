import { beforeEach, describe, expect, it } from "vitest";
import { storageKey } from "@/lib/brand";
import {
  forgetSyndicateTransport,
  getSyndicateTransportSnapshot,
  recordSyndicateTransport,
  subscribeSyndicateTransportSnapshot,
  syndicateTransportObservation,
} from "@/lib/syndicateTransportStatus";

const STORAGE_KEY = storageKey("syndicate-transport-status-v1");

describe("syndicateTransportStatus", () => {
  beforeEach(() => {
    forgetSyndicateTransport("machine-1");
    forgetSyndicateTransport("machine-2");
    localStorage.clear();
  });

  it("records an observation per machine and device", () => {
    recordSyndicateTransport("machine-1", "device-1", "packet-relay", 1_000);
    recordSyndicateTransport("machine-1", "device-2", "ssh-forward", 2_000);

    const snapshot = getSyndicateTransportSnapshot();
    expect(syndicateTransportObservation(snapshot, "machine-1", "device-1")).toEqual({
      transport: "packet-relay",
      observedAt: 1_000,
    });
    // A replaced device must not inherit the previous device's carrier.
    expect(syndicateTransportObservation(snapshot, "machine-1", "device-2")).toEqual({
      transport: "ssh-forward",
      observedAt: 2_000,
    });
    expect(syndicateTransportObservation(snapshot, "machine-1", "device-3")).toBeUndefined();
  });

  it("throttles repeat writes for an unchanged transport", () => {
    // An active pane polls output every 25 ms and sends one request per
    // keystroke. Persisting each one is ~40 localStorage writes a second, each
    // re-rendering the machines card, to move a timestamp nobody reads at that
    // resolution.
    let notifications = 0;
    const unsubscribe = subscribeSyndicateTransportSnapshot(() => {
      notifications += 1;
    });

    recordSyndicateTransport("machine-1", "device-1", "packet-relay", 1_000);
    for (let offset = 25; offset < 1_000; offset += 25) {
      recordSyndicateTransport("machine-1", "device-1", "packet-relay", 1_000 + offset);
    }

    expect(notifications).toBe(1);
    expect(
      syndicateTransportObservation(getSyndicateTransportSnapshot(), "machine-1", "device-1")
        ?.observedAt,
    ).toBe(1_000);
    unsubscribe();
  });

  it("records a change of carrier immediately", () => {
    // Throttling must never hide the part users act on.
    recordSyndicateTransport("machine-1", "device-1", "ssh-forward", 1_000);
    recordSyndicateTransport("machine-1", "device-1", "packet-relay", 1_025);

    expect(
      syndicateTransportObservation(getSyndicateTransportSnapshot(), "machine-1", "device-1"),
    ).toEqual({ transport: "packet-relay", observedAt: 1_025 });
  });

  it("resumes writing once the throttle window has passed", () => {
    recordSyndicateTransport("machine-1", "device-1", "packet-relay", 1_000);
    recordSyndicateTransport("machine-1", "device-1", "packet-relay", 1_000 + 30_000);

    expect(
      syndicateTransportObservation(getSyndicateTransportSnapshot(), "machine-1", "device-1")
        ?.observedAt,
    ).toBe(31_000);
  });

  it("forgets every device belonging to one machine", () => {
    recordSyndicateTransport("machine-1", "device-1", "packet-relay", 1_000);
    recordSyndicateTransport("machine-1", "device-2", "ssh-forward", 1_000);
    recordSyndicateTransport("machine-2", "device-3", "ssh-forward", 1_000);

    forgetSyndicateTransport("machine-1");

    const snapshot = getSyndicateTransportSnapshot();
    expect(syndicateTransportObservation(snapshot, "machine-1", "device-1")).toBeUndefined();
    expect(syndicateTransportObservation(snapshot, "machine-1", "device-2")).toBeUndefined();
    expect(syndicateTransportObservation(snapshot, "machine-2", "device-3")).toBeDefined();
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    let notifications = 0;
    const unsubscribe = subscribeSyndicateTransportSnapshot(() => {
      notifications += 1;
    });

    recordSyndicateTransport("machine-1", "device-1", "packet-relay", 1_000);
    expect(notifications).toBe(1);

    unsubscribe();
    recordSyndicateTransport("machine-1", "device-1", "ssh-forward", 2_000);
    expect(notifications).toBe(1);
  });

  it("persists observations and drops malformed stored entries on reload", async () => {
    recordSyndicateTransport("machine-1", "device-1", "packet-relay", 1_000);
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored).toMatchObject({ "machine-1\ndevice-1": { transport: "packet-relay" } });

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        "machine-1\ndevice-1": { transport: "packet-relay", observedAt: 1_000 },
        "machine-1\ndevice-2": { transport: "carrier-pigeon", observedAt: 1_000 },
        "machine-1\ndevice-3": { transport: "ssh-forward", observedAt: "recently" },
        "machine-1\ndevice-4": null,
      }),
    );
    const reloaded = await import(`@/lib/syndicateTransportStatus?reload=${Date.now()}`);
    const snapshot = reloaded.getSyndicateTransportSnapshot();

    expect(reloaded.syndicateTransportObservation(snapshot, "machine-1", "device-1")).toEqual({
      transport: "packet-relay",
      observedAt: 1_000,
    });
    for (const deviceId of ["device-2", "device-3", "device-4"]) {
      expect(
        reloaded.syndicateTransportObservation(snapshot, "machine-1", deviceId),
      ).toBeUndefined();
    }
  });
});
