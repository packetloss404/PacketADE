/**
 * One source of truth for the localStorage prefix.
 *
 * `CLAUDE.md` says never to hardcode `"packetbench:"` and to build every key
 * through `storageKey()` in `src/lib/brand.ts`. That helper has existed since
 * the PacketCode -> PacketADE rename (`ddfd96fa`, 2026-04-18), but two renames
 * later exactly half the production files that persist anything still carried
 * the literal: the PacketADE -> PacketBench rename (`5404fb85`) rewrote the
 * strings in place instead of converting the call sites.
 *
 * Why that matters, and why a fence rather than a comment:
 *
 * `storageMirror.ts:158,204` decides what to mirror into
 * `~/.packetbench/webview-storage-mirror.json` with
 * `key.startsWith(STORAGE_PREFIX)`, and `storage-migration.ts:74-84` copies the
 * one previous prefix forward the same way. Those two are the only reason a
 * bundle-identifier change does not wipe the app's state — which is exactly
 * what it did at the last rename (`storageMirror.ts:10-18`).
 *
 * So a hardcoded key is not a style nit. At the NEXT rename, `STORAGE_PREFIX`
 * moves, `LEGACY_STORAGE_PREFIX` becomes `packetbench:`, and every hardcoded
 * store keeps reading and writing a prefix that is no longer mirrored. Their
 * data quietly stops being backed up, and the following bundle-identifier
 * change takes it with no migration path, because the migration only knows one
 * previous prefix. Nothing fails loudly at any point.
 *
 * Audit F24 / P16.
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
      if (entry.name === "__tests__") continue;
      files.push(...sourceFiles(path));
    } else if ([".ts", ".tsx"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

/**
 * A quoted string that begins with the brand's storage prefix.
 *
 * Deliberately matches the literal `packetbench:` rather than importing
 * `STORAGE_PREFIX`: the point is to catch the hardcoded spelling, so the fence
 * has to know the spelling. When the product is renamed again, update this
 * constant in the same change as `brand.ts` — and the fence will then prove the
 * conversion was complete.
 */
const HARDCODED_PREFIX = /["'`]packetbench:/;

/**
 * Uses of the prefix that are not localStorage keys and are therefore outside
 * what `storageMirror` cares about. Each is a DOM `CustomEvent` name or an
 * identifier: both sides of those already share one exported constant, so a
 * rename cannot desynchronise them the way a storage key can.
 *
 * `src/lib/brand.ts` is the definition itself.
 */
const ALLOWED = new Set(
  [
    "src/lib/brand.ts",
    "src/components/agents/paneEvents.ts",
    "src/components/views/tools/SubscriptionsCard.tsx",
    "src/stores/boundedAutonomyRuntime.ts",
    // One-shot removal of a key retired before the rename; it must keep naming
    // the prefix that key was actually written under.
    "src/lib/bootstrap.ts",
  ].map((p) => p.replaceAll("/", "\\")),
);

/** Blank quoted spans out of comments so prose cannot trip the fence. */
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

describe("localStorage key branding", () => {
  it(
    "no production file hardcodes the storage prefix",
    () => {
      const offenders = [];
      for (const file of SRC_FILES) {
        const rel = relative(ROOT, file);
        if (ALLOWED.has(rel) || ALLOWED.has(rel.replaceAll("\\", "/"))) continue;
        for (const line of codeLines(readFileSync(file, "utf8"))) {
          if (HARDCODED_PREFIX.test(line)) {
            offenders.push(`${rel}: ${line.trim()}`);
            break;
          }
        }
      }

      expect(
        offenders,
        `Build these with storageKey() from @/lib/brand instead. A hardcoded prefix ` +
          `survives a rename that STORAGE_PREFIX does not, and storageMirror stops ` +
          `mirroring it — silently. See the header of this file.`,
      ).toEqual([]);
    },
    FENCE_TIMEOUT_MS,
  );

  it(
    "the allowlist has no stale entries",
    () => {
      // An allowlisted file that no longer contains the prefix means the
      // exemption outlived its reason. Drop it, so the list stays honest.
      const stale = [];
      for (const rel of ALLOWED) {
        const path = join(ROOT, rel);
        let body;
        try {
          body = readFileSync(path, "utf8");
        } catch {
          stale.push(`${rel} (no longer exists)`);
          continue;
        }
        if (!codeLines(body).some((line) => HARDCODED_PREFIX.test(line))) {
          stale.push(`${rel} (no longer uses the prefix)`);
        }
      }
      expect(stale).toEqual([]);
    },
    FENCE_TIMEOUT_MS,
  );
});
