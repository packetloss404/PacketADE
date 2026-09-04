import { beforeEach, describe, expect, it, vi } from "vitest";

import { STORAGE_PREFIX } from "@/lib/brand";
import {
  bootPersistedStorage,
  getStorageBootRecord,
  resetStorageBootRecord,
} from "@/lib/storage-boot";

// No Tauri in this environment, so the mirror boots inert. That is the point
// of these cases: the record must be produced and readable regardless.
describe("storage boot record", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStorageBootRecord();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  /**
   * REGRESSION: `bootPersistedStorage` runs before React exists, and its result
   * was returned to `main.tsx` and dropped on the floor. A typed outcome with
   * no reachable reader is the same shape that hid the PTY exit payload — and
   * here it is the specific thing the backlog asked for: a fact the next person
   * can see, rather than an absence.
   */
  it("is reachable after boot, which is when the UI reads it", async () => {
    expect(getStorageBootRecord()).toBeNull();

    const returned = await bootPersistedStorage();

    expect(getStorageBootRecord()).toBe(returned);
    expect(getStorageBootRecord()).toMatchObject({
      at: expect.any(Number),
      monitorWindow: false,
      mirror: { active: false, restored: 0, reason: "no-tauri" },
      legacy: { status: "ran", record: { legacyKeysFound: 0, migrated: 0 } },
    });
  });

  it("carries the legacy migration fact, not merely that it completed", async () => {
    localStorage.setItem("packetade:flights", "legacy-flights");

    const record = await bootPersistedStorage();

    expect(record.legacy).toMatchObject({
      status: "ran",
      record: { legacyKeysFound: 1, migrated: 1 },
    });
    expect(localStorage.getItem(STORAGE_PREFIX + "flights")).toBe("legacy-flights");
  });

  it("reports zero-found distinctly from a migration whose count is unknown", async () => {
    const empty = await bootPersistedStorage();
    expect(empty.legacy).toMatchObject({ status: "ran", record: { legacyKeysFound: 0 } });

    // An install that migrated before the record existed: guard set, no record.
    localStorage.clear();
    localStorage.setItem(STORAGE_PREFIX + "migrated-from-packetade", "1");
    resetStorageBootRecord();

    const unknown = await bootPersistedStorage();
    expect(unknown.legacy).toEqual({ status: "already-ran", record: null });
  });

  it("never rejects, so a storage failure cannot stop the app booting", async () => {
    const broken = {
      get length(): number {
        throw new Error("site data blocked");
      },
      clear: () => {},
      getItem: () => {
        throw new Error("site data blocked");
      },
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new Error("site data blocked");
      },
    } as unknown as Storage;
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: broken,
      writable: true,
    });

    try {
      const record = await bootPersistedStorage();
      expect(record.legacy.status).toBe("failed");
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
        writable: true,
      });
    }
  });
});
