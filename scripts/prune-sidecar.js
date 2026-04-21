#!/usr/bin/env node
/**
 * prune-sidecar.js
 *
 * Strips devDependencies from `agent-sidecar/node_modules` so the Tauri
 * bundler can pick up a minimal, production-only dependency tree. Runs
 * after `sidecar:install` + `sidecar:build` in the `prebundle` chain that
 * Tauri's `beforeBuildCommand` invokes.
 *
 * Behaviour:
 *   1. Verifies `agent-sidecar/dist/` exists. If not, the build step did
 *      not run and this script refuses to proceed (exit 1). We do NOT
 *      silently re-run the build — that's the caller's job.
 *   2. Invokes `pnpm -C agent-sidecar install --prod --ignore-scripts`
 *      to re-materialise node_modules with production deps only. This
 *      is DESTRUCTIVE to devDependencies: after a production build the
 *      repo's sidecar node_modules will be missing `typescript` and
 *      `@types/node`. Re-run `pnpm sidecar:install` to restore dev deps
 *      before further sidecar development work.
 *   3. Walks the pruned tree and prints a size summary (human-friendly
 *      bytes + file count) so CI logs show what's about to be bundled.
 *
 * Uses only Node stdlib + the root devDependencies already installed.
 * No new dependency is introduced.
 *
 * Node 18+ required (ESM + `node:` stdlib imports).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..");
const SIDECAR_DIR = path.join(REPO_ROOT, "agent-sidecar");
const SIDECAR_DIST = path.join(SIDECAR_DIR, "dist");
const SIDECAR_NODE_MODULES = path.join(SIDECAR_DIR, "node_modules");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(message) {
  process.stdout.write(`prune-sidecar: ${message}\n`);
}

function fail(message, cause) {
  process.stderr.write(`prune-sidecar: ERROR ${message}\n`);
  if (cause) {
    process.stderr.write(`prune-sidecar: cause: ${cause.stack ?? cause}\n`);
  }
  process.exit(1);
}

/**
 * Recursively walk a directory and return `{ bytes, files }`. Uses
 * `lstatSync` via `statSync` defaults so symlinks are followed once;
 * pnpm's store layout uses symlinks inside `.pnpm/`, but sizes there
 * resolve to the real files under `.pnpm/<pkg>/node_modules/...` which
 * we also descend into directly, so double-counting is avoided by
 * recording inode keys.
 */
function walk(root) {
  const seenInodes = new Set();
  let bytes = 0;
  let files = 0;

  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // A missing or permission-denied dir during walking is not fatal
      // for a *report* — we just skip it and continue.
      process.stderr.write(
        `prune-sidecar: warn: could not read ${dir}: ${err.message}\n`,
      );
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        const key = `${st.dev}:${st.ino}`;
        if (st.ino !== 0 && seenInodes.has(key)) continue;
        if (st.ino !== 0) seenInodes.add(key);
        bytes += st.size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

function resolvePnpmCommand() {
  // On Windows, pnpm is a `.CMD` shim. `spawnSync` with `shell: true`
  // is the portable way to locate it via PATH.
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // 1. Pre-flight: dist/ must exist.
  if (!existsSync(SIDECAR_DIST)) {
    fail(
      `${SIDECAR_DIST} is missing — the sidecar build did not run. ` +
        `This script is intended to run after 'pnpm sidecar:build' in the prebundle chain.`,
    );
  }

  // 2a. Run pnpm install --prod --ignore-scripts in the sidecar workspace.
  //     This removes top-level symlinks for devDependencies but leaves
  //     their unpacked tarballs in node_modules/.pnpm/.
  log(`pruning devDependencies in ${SIDECAR_DIR}`);
  const pnpmCmd = resolvePnpmCommand();
  const installResult = spawnSync(
    pnpmCmd,
    ["-C", SIDECAR_DIR, "install", "--prod", "--ignore-scripts"],
    {
      stdio: "inherit",
      // `shell: true` on Windows lets `.cmd` shim resolution happen via
      // cmd.exe's PATHEXT logic; harmless on POSIX.
      shell: process.platform === "win32",
    },
  );
  if (installResult.error) {
    fail(`failed to spawn pnpm install`, installResult.error);
  }
  if (installResult.status !== 0) {
    fail(
      `pnpm install --prod exited with status ${installResult.status} ` +
        `(signal ${installResult.signal ?? "none"})`,
    );
  }

  // 2b. Run `pnpm prune --prod` to actually evict the unreferenced
  //     devDependency content from `node_modules/.pnpm/`. Without this,
  //     `typescript` and `@types/node` remain on disk inside the virtual
  //     store even though they're no longer symlinked at the top level —
  //     and the Tauri bundler would still ship them.
  log(`evicting unreferenced packages from virtual store`);
  const pruneResult = spawnSync(
    pnpmCmd,
    ["-C", SIDECAR_DIR, "prune", "--prod"],
    {
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  if (pruneResult.error) {
    fail(`failed to spawn pnpm prune`, pruneResult.error);
  }
  if (pruneResult.status !== 0) {
    fail(
      `pnpm prune --prod exited with status ${pruneResult.status} ` +
        `(signal ${pruneResult.signal ?? "none"})`,
    );
  }

  // 3. Report size of the pruned tree.
  if (!existsSync(SIDECAR_NODE_MODULES)) {
    fail(
      `${SIDECAR_NODE_MODULES} is missing after prune — this should not happen. ` +
        `Inspect the pnpm output above.`,
    );
  }
  const { bytes, files } = walk(SIDECAR_NODE_MODULES);
  log(
    `pruned node_modules: ${formatBytes(bytes)} across ${files} files (path=${SIDECAR_NODE_MODULES})`,
  );
  log(
    `NOTE: devDependencies (typescript, @types/node) were removed. ` +
      `Run 'pnpm sidecar:install' to restore them for dev work.`,
  );
}

main();
