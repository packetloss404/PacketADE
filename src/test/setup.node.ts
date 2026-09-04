/**
 * Setup for the `node` Vitest project (environment: "node").
 *
 * Deliberately does NOT import `@testing-library/jest-dom` — its matchers are
 * DOM-only. Anything needing those matchers belongs in the `dom` project
 * (see `DOM_TEST_GLOBS` in `vitest.config.ts`).
 *
 * jsdom hands every test file its own fresh `localStorage`. `globalThis` is not
 * guaranteed to be recycled between files in the node pool, so install a fresh
 * in-memory Storage unconditionally here to preserve that per-file isolation.
 */
import { createMemoryStorage, defineStorage } from "./memoryStorage";

const memoryStorage = createMemoryStorage();
defineStorage(globalThis, memoryStorage);
defineStorage(globalThis, createMemoryStorage(), "sessionStorage");
