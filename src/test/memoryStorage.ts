/**
 * Shared `Storage` shim used by both Vitest setup files.
 *
 * Under `environment: "jsdom"` the DOM already supplies `window.localStorage`,
 * so this is only a fallback. Under `environment: "node"` there is no Storage
 * implementation at all, and the Zustand `persist` middleware (plus a handful
 * of migration helpers) reads `globalThis.localStorage` at module-init time —
 * so node-environment tests get a fresh in-memory implementation instead.
 */

export function hasStorageMethods(value: unknown): value is Storage {
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

/**
 * A `Storage` whose *named properties* behave like the real thing.
 *
 * A plain object with the six methods is not enough. The DOM's `Storage` is a
 * named-property exotic object: stored keys are enumerable own properties, so
 * `Object.keys(localStorage)` lists the KEYS and `localStorage.foo` reads an
 * entry. A plain object gets that exactly backwards — enumeration returns
 * `["length", "clear", "getItem", …]` and never a stored key.
 *
 * That is not a theoretical difference. It silently broke a real assertion
 * (`expect(Object.keys(localStorage)).toContain("packetbench:issues")`), which
 * passed under jsdom and failed under node for a reason that had nothing to do
 * with the code under test. A shim that diverges from the platform turns an
 * environment change into a fake test failure, so this one uses a Proxy to
 * present entries as own properties and keep the methods non-enumerable.
 */
export function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  const api = {
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

  const isApiMember = (prop: string | symbol) =>
    typeof prop !== "string" || Reflect.has(api, prop);

  return new Proxy(api, {
    get(target, prop, receiver) {
      if (isApiMember(prop)) return Reflect.get(target, prop, receiver);
      return entries.get(prop as string);
    },
    set(target, prop, value, receiver) {
      if (isApiMember(prop)) return Reflect.set(target, prop, value, receiver);
      entries.set(prop as string, String(value));
      return true;
    },
    has(target, prop) {
      if (typeof prop === "string" && entries.has(prop)) return true;
      return Reflect.has(target, prop);
    },
    deleteProperty(target, prop) {
      if (isApiMember(prop)) return Reflect.deleteProperty(target, prop);
      entries.delete(prop as string);
      return true;
    },
    // Only stored keys enumerate, matching the platform. Every own property of
    // `api` is configurable, so omitting them here breaks no Proxy invariant.
    ownKeys: () => Array.from(entries.keys()),
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string" && entries.has(prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: entries.get(prop),
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  }) as unknown as Storage;
}

export function defineStorage(target: object, storage: Storage, property = "localStorage") {
  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: true,
    value: storage,
    writable: true,
  });
}
