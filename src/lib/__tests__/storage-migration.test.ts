import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_STORAGE_PREFIX, STORAGE_PREFIX } from "@/lib/brand";
import { migrateLegacyStorage } from "@/lib/storage-migration";

const GUARD_KEY = STORAGE_PREFIX + "migrated-from-packetcode";

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
