import "@testing-library/jest-dom";

function hasStorageMethods(value: unknown): value is Storage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Storage>;
  return (
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function" &&
    typeof candidate.clear === "function" &&
    typeof candidate.key === "function"
  );
}

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.get(String(key)) ?? null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(String(key));
    },
    setItem(key: string, value: string) {
      entries.set(String(key), String(value));
    },
  };
}

function defineStorage(target: object, storage: Storage) {
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    enumerable: true,
    value: storage,
    writable: true,
  });
}

const windowStorage =
  typeof window !== "undefined" && hasStorageMethods(window.localStorage)
    ? window.localStorage
    : createMemoryStorage();

if (typeof window !== "undefined" && !hasStorageMethods(window.localStorage)) {
  defineStorage(window, windowStorage);
}

if (!hasStorageMethods(globalThis.localStorage)) {
  defineStorage(globalThis, windowStorage);
}
