/**
 * User-visible copy says the app's name through `APP_NAME`.
 *
 * Companion to `storage-key-brand.test.mjs`. That one guards persisted keys,
 * where a missed call site loses data. This one guards displayed copy, where a
 * missed call site just leaves the old product name on screen after a rename —
 * cosmetic, but it is the long tail that made the last two renames a ~400-file
 * sweep instead of a one-file change (`src/lib/brand.ts` header).
 *
 * Scope, deliberately narrow: this fence reads CODE, not comments. Comments and
 * JSDoc naming the product are documentation for a human, and rewriting them as
 * `${APP_NAME}` would make them worse, not better.
 *
 * Audit F25 / P17.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "test") continue;
      files.push(...sourceFiles(path));
    } else if ([".ts", ".tsx"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Files allowed to spell the product name literally, each for a stated reason.
 *
 * These are NOT "not got to yet". Every entry is a string that must survive a
 * rename unchanged, which is the opposite of what `APP_NAME` does:
 *
 * - `src/lib/brand.ts` — the definition.
 * - The `Run-By:` trailer is a cross-language format contract. The identical
 *   literal lives in `src-tauri/src/core/orchestrator.rs:10`, is written into
 *   git commit messages that already exist in history, and is matched by a
 *   glob inside a generated git hook shell script
 *   (`src-tauri/src/core/worktree.rs:508,580`). Making only the TypeScript side
 *   dynamic would let the two halves diverge at the next rename, which is worse
 *   than leaving both literal. Rename it on both sides, deliberately, or not at
 *   all.
 */
const ALLOWED = new Map([
  ["src/lib/brand.ts", "defines APP_NAME"],
  ["src/lib/tauri.ts", "Run-By trailer template — matches orchestrator.rs:10"],
  ["src/stores/orchestrationSettingsStore.ts", "Run-By trailer template — matches orchestrator.rs:10"],
]);

/**
 * Strip comments, then keep only what is inside a quoted span or is JSX text.
 *
 * Block comments go first (they can contain stray quotes), then each line's
 * `//` tail. Anything left that still names the product is either a string
 * literal or text rendered to the user — both of which should be `APP_NAME`.
 */
function codeLines(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*/, ""));
}

const SRC_FILES = sourceFiles(join(ROOT, "src"));

// A filesystem fence, not a unit test: under a full parallel run it contends
// with the rest of the suite for the disk, and vitest's 5 s default would make
// it fail for reasons unrelated to what it guards.
const FENCE_TIMEOUT_MS = 30_000;

describe("user-visible product name", () => {
  it(
    "no production file spells the product name in code",
    () => {
      const offenders = [];
      for (const file of SRC_FILES) {
        const rel = relative(ROOT, file).replaceAll("\\", "/");
        if (ALLOWED.has(rel)) continue;
        for (const line of codeLines(readFileSync(file, "utf8"))) {
          if (line.includes("PacketBench")) {
            offenders.push(`${rel}: ${line.trim()}`);
            break;
          }
        }
      }

      expect(
        offenders,
        `Use APP_NAME from @/lib/brand for copy the user sees. If the string must ` +
          `survive a rename unchanged — a format contract, an external identifier — ` +
          `add it to ALLOWED in this file with the reason.`,
      ).toEqual([]);
    },
    FENCE_TIMEOUT_MS,
  );

  it(
    "the allowlist has no stale entries",
    () => {
      const stale = [];
      for (const [rel, reason] of ALLOWED) {
        let body;
        try {
          body = readFileSync(join(ROOT, rel), "utf8");
        } catch {
          stale.push(`${rel} (no longer exists) — was: ${reason}`);
          continue;
        }
        if (!codeLines(body).some((line) => line.includes("PacketBench"))) {
          stale.push(`${rel} (no longer spells it) — was: ${reason}`);
        }
      }
      expect(stale).toEqual([]);
    },
    FENCE_TIMEOUT_MS,
  );
});
