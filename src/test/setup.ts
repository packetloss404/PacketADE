/**
 * Setup for the `dom` Vitest project (environment: "jsdom").
 *
 * Node-environment tests use `./setup.node.ts` instead — it deliberately skips
 * `@testing-library/jest-dom`, whose matchers need a real `document`.
 */
import "@testing-library/jest-dom";
import { createMemoryStorage, defineStorage, hasStorageMethods } from "./memoryStorage";

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
