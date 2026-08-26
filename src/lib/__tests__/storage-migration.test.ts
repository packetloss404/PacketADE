import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_STORAGE_PREFIX, STORAGE_PREFIX } from "@/lib/brand";
import { migrateIssuesMissionToFlight, migrateLegacyStorage } from "@/lib/storage-migration";

const GUARD_KEY = STORAGE_PREFIX + "migrated-from-packetade";
const MISSION_GUARD_KEY = STORAGE_PREFIX + "migrated-mission-to-flight";
const ISSUES_KEY = STORAGE_PREFIX + "issues";

class MutationSensitiveStorage implements Storage {
  private readonly entries = new Map<string, string>();
  private failOnKeyAfterMigrationWrite = false;
  private watchingMigrationWrites = false;

  get length() {
    return this.entries.size;
  }

  armMutationGuard() {
    this.watchingMigrationWrites = true;
  }

  clear() {
    this.entries.clear();
    this.failOnKeyAfterMigrationWrite = false;
  }

  getItem(key: string) {
    return this.entries.get(String(key)) ?? null;
  }

  key(index: number) {
    if (this.failOnKeyAfterMigrationWrite) {
      throw new Error("localStorage.key called after migration writes began");
    }

    return Array.from(this.entries.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.entries.delete(String(key));
  }

  setItem(key: string, value: string) {
    const normalizedKey = String(key);
    if (this.watchingMigrationWrites && normalizedKey.startsWith(STORAGE_PREFIX)) {
      this.failOnKeyAfterMigrationWrite = true;
    }

    this.entries.set(normalizedKey, String(value));
  }
}

function defineLocalStorage(storage: Storage) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: true,
    value: storage,
    writable: true,
  });

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    enumerable: true,
    value: storage,
    writable: true,
  });
}

describe("migrateLegacyStorage", () => {
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    defineLocalStorage(originalLocalStorage);
    localStorage.clear();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    defineLocalStorage(originalLocalStorage);
    localStorage.clear();
  });

  it("snapshots keys before copying multiple legacy entries", () => {
    const storage = new MutationSensitiveStorage();
    storage.setItem(LEGACY_STORAGE_PREFIX + "flights", "legacy-flights");
    storage.setItem(LEGACY_STORAGE_PREFIX + "profiles", "legacy-profiles");
    storage.setItem("unrelated", "ignored");
    storage.armMutationGuard();
    defineLocalStorage(storage);

    migrateLegacyStorage();

    expect(localStorage.getItem(STORAGE_PREFIX + "flights")).toBe("legacy-flights");
    expect(localStorage.getItem(STORAGE_PREFIX + "profiles")).toBe("legacy-profiles");
    expect(localStorage.getItem("unrelated")).toBe("ignored");
    expect(localStorage.getItem(GUARD_KEY)).toBe("1");
  });

  it("does not clobber an existing new key", () => {
    localStorage.setItem(LEGACY_STORAGE_PREFIX + "settings", "legacy-settings");
    localStorage.setItem(STORAGE_PREFIX + "settings", "current-settings");

    migrateLegacyStorage();

    expect(localStorage.getItem(STORAGE_PREFIX + "settings")).toBe("current-settings");
    expect(localStorage.getItem(LEGACY_STORAGE_PREFIX + "settings")).toBe("legacy-settings");
    expect(localStorage.getItem(GUARD_KEY)).toBe("1");
  });
});

describe("migrateIssuesMissionToFlight", () => {
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    defineLocalStorage(originalLocalStorage);
    localStorage.clear();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    defineLocalStorage(originalLocalStorage);
    localStorage.clear();
  });

  it("rewrites the legacy missionId flight link to flightId and drops the old key", () => {
    localStorage.setItem(
      ISSUES_KEY,
      JSON.stringify({
        issues: [
          { id: "i1", title: "A", missionId: "F-1" },
          { id: "i2", title: "B", flightId: "F-2" },
        ],
        nextTicketNum: 3,
      }),
    );

    migrateIssuesMissionToFlight();

    const parsed = JSON.parse(localStorage.getItem(ISSUES_KEY) as string);
    expect(parsed.issues[0].flightId).toBe("F-1");
    expect("missionId" in parsed.issues[0]).toBe(false);
    expect(parsed.issues[1].flightId).toBe("F-2");
    // Unrelated fields survive.
    expect(parsed.nextTicketNum).toBe(3);
    expect(localStorage.getItem(MISSION_GUARD_KEY)).toBe("1");
  });

  it("is a no-op once the guard is set", () => {
    localStorage.setItem(MISSION_GUARD_KEY, "1");
    const blob = JSON.stringify({ issues: [{ id: "i1", missionId: "F-1" }] });
    localStorage.setItem(ISSUES_KEY, blob);

    migrateIssuesMissionToFlight();

    // Untouched — the guard short-circuits before any rewrite.
    expect(localStorage.getItem(ISSUES_KEY)).toBe(blob);
  });

  it("sets the guard even when there is nothing to migrate", () => {
    localStorage.setItem(
      ISSUES_KEY,
      JSON.stringify({ issues: [{ id: "i1", flightId: "F-9" }] }),
    );

    migrateIssuesMissionToFlight();

    const parsed = JSON.parse(localStorage.getItem(ISSUES_KEY) as string);
    expect(parsed.issues[0].flightId).toBe("F-9");
    expect(localStorage.getItem(MISSION_GUARD_KEY)).toBe("1");
  });
});
