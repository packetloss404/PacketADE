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
 *   2. Resolves the build's Rust target triple (scripts/target-triple.js;
 *      `--target=` → TAURI_ENV_TARGET_TRIPLE → TAURI_TARGET → host) and
 *      invokes `pnpm -C agent-sidecar install --prod --ignore-scripts`
 *      with pnpm's `supportedArchitectures` temporarily injected into
 *      agent-sidecar/package.json so the TARGET platform's native deps
 *      are materialised (the original package.json is restored
 *      byte-exact afterwards). This is DESTRUCTIVE to devDependencies:
 *      after a production build the repo's sidecar node_modules will be
 *      missing `typescript` and `@types/node`. Re-run
 *      `pnpm sidecar:install` to restore dev deps before further sidecar
 *      development work.
 *   3. Walks the pruned tree and prints a size summary (human-friendly
 *      bytes + file count) so CI logs show what's about to be bundled.
 *   4. Asserts the target's `@anthropic-ai/claude-agent-sdk-<os>-<cpu>`
 *      platform package is present (non-empty `claude` executable) and
 *      that no foreign-platform variant leaked in; exits 1 otherwise,
 *      aborting the Tauri beforeBuildCommand.
 *
 * Uses only Node stdlib + the root devDependencies already installed.
 * No new dependency is introduced.
 *
 * Node 18+ required (ESM + `node:` stdlib imports).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveTarget,
  sidecarPlatformPackage,
  tripleToSupportedArchitectures,
} from "./target-triple.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..");
const SIDECAR_DIR = path.join(REPO_ROOT, "agent-sidecar");
const SIDECAR_DIST = path.join(SIDECAR_DIR, "dist");
const SIDECAR_NODE_MODULES = path.join(SIDECAR_DIR, "node_modules");
const SIDECAR_PKG_JSON = path.join(SIDECAR_DIR, "package.json");

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
      process.stderr.write(`prune-sidecar: warn: could not read ${dir}: ${err.message}\n`);
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

function pnpmSpawn(commandArgs) {
  const env = {
    ...process.env,
    NODE_OPTIONS: [
      ...(process.env.NODE_OPTIONS ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .filter((option) => option !== "--trace-deprecation"),
      "--no-deprecation",
    ].join(" "),
  };

  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", ...commandArgs],
      env,
    };
  }

  return { command: "pnpm", args: commandArgs, env };
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

  // 2a. Wipe node_modules entirely. The Tauri bundler walks resource
  //     directories and chokes on pnpm's symlinked `.pnpm/` store when
  //     any transitive entry points at a removed path (e.g. after devDep
  //     removal leaves a dangling `undici-types` link). A clean slate
  //     guarantees a walkable tree.
  log(`wiping ${SIDECAR_NODE_MODULES} for a clean prod install`);
  if (existsSync(SIDECAR_NODE_MODULES)) {
    try {
      rmSync(SIDECAR_NODE_MODULES, { recursive: true, force: true });
    } catch (err) {
      fail(`failed to remove ${SIDECAR_NODE_MODULES}`, err);
    }
  }

  // 2b. Resolve the Rust target triple this build is for, so the prod
  //     install materialises the TARGET platform's native deps (e.g. the
  //     @anthropic-ai/claude-agent-sdk-<os>-<cpu> package carrying the
  //     `claude` executable) rather than the HOST's. Without this, any
  //     cross-arch build ships a target `node` next to a host-arch
  //     `claude` and the sidecar cannot launch.
  let target;
  try {
    target = resolveTarget({ argv: process.argv, env: process.env });
  } catch (err) {
    fail(`could not resolve build target`, err);
  }
  log(`resolved build target: ${target}`);
  const supportedArchitectures = tripleToSupportedArchitectures(target);
  log(`pnpm supportedArchitectures: ${JSON.stringify(supportedArchitectures)}`);

  // 2c. Re-install with a hoisted (flat) node_modules layout. This
  //     produces a symlink-free, Tauri-bundler-friendly tree containing
  //     only production dependencies. pnpm's `supportedArchitectures`
  //     must go through the package.json `pnpm` field (the CLI
  //     `--config.supportedArchitectures...` form is non-functional in
  //     pnpm 9.15.4), so we temporarily inject it and restore the
  //     byte-exact original afterwards.
  log(`installing prod deps with hoisted linker in ${SIDECAR_DIR}`);
  const rawSidecarPkg = readFileSync(SIDECAR_PKG_JSON);
  let sidecarPkg;
  try {
    sidecarPkg = JSON.parse(rawSidecarPkg.toString("utf8"));
  } catch (err) {
    fail(`could not parse ${SIDECAR_PKG_JSON}`, err);
  }
  sidecarPkg.pnpm = {
    ...(sidecarPkg.pnpm ?? {}),
    supportedArchitectures,
  };

  // Capture install failures instead of exiting inside the try block —
  // fail() calls process.exit(1), which would skip the `finally` restore.
  let installFailure = null;
  try {
    writeFileSync(SIDECAR_PKG_JSON, `${JSON.stringify(sidecarPkg, null, 2)}\n`);
    const pnpm = pnpmSpawn([
      // `--ignore-workspace` is load-bearing and must come first, exactly as
      // in the `sidecar:install` script. agent-sidecar is NOT a member of the
      // root `pnpm-workspace.yaml` (`packages: ["remoteagents/*"]`), but pnpm
      // still walks up from `-C agent-sidecar`, finds that file, and installs
      // the ROOT WORKSPACE instead. With `--prod` that strips the repo's own
      // devDependencies (vite, typescript, vitest, @tauri-apps/cli, eslint)
      // and never creates agent-sidecar/node_modules at all.
      "--ignore-workspace",
      "-C",
      SIDECAR_DIR,
      "install",
      "--prod",
      "--ignore-scripts",
      "--config.node-linker=hoisted",
      // Step 2a just deleted `node_modules` on purpose, but pnpm still asks
      // "The modules directories will be removed and reinstalled from
      // scratch. Proceed? (Y/n)" before it will repopulate them. With
      // `stdio: "inherit"` on a non-TTY (CI, a build script, an agent shell)
      // that prompt cannot be answered: pnpm exits 0 without installing, and
      // the existence check below then fails with "node_modules is missing
      // after prune". Answering it up front makes `pnpm tauri build`
      // reproducible off a terminal.
      "--config.confirm-modules-purge=false",
    ]);
    const installResult = spawnSync(pnpm.command, pnpm.args, {
      env: pnpm.env,
      shell: false,
      stdio: "inherit",
    });
    if (installResult.error) {
      installFailure = { message: `failed to spawn pnpm install`, cause: installResult.error };
    } else if (installResult.status !== 0) {
      installFailure = {
        message:
          `pnpm install --prod exited with status ${installResult.status} ` +
          `(signal ${installResult.signal ?? "none"})`,
        cause: null,
      };
    }
  } finally {
    // Restore the byte-exact original package.json no matter what.
    writeFileSync(SIDECAR_PKG_JSON, rawSidecarPkg);
  }
  if (installFailure) {
    fail(installFailure.message, installFailure.cause);
  }

  // 2d. Remove the `.pnpm/` metadata directory. With a hoisted layout it
  //     only contains pnpm's lock.yaml; leaving it adds nothing except
  //     resource-walk noise for the Tauri bundler.
  const pnpmMeta = path.join(SIDECAR_NODE_MODULES, ".pnpm");
  if (existsSync(pnpmMeta)) {
    log(`removing ${pnpmMeta} (hoisted install leftover)`);
    try {
      rmSync(pnpmMeta, { recursive: true, force: true });
    } catch (err) {
      fail(`failed to remove ${pnpmMeta}`, err);
    }
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

  // 4. Build-failing asserts: the pruned tree must contain the TARGET's
  //    claude-agent-sdk platform package (with a non-empty `claude`
  //    executable) and NO foreign-platform variant. Failing here aborts
  //    the Tauri beforeBuildCommand before a broken bundle ships.
  const platformPkg = sidecarPlatformPackage(target);
  const claudeBinName = target.includes("-windows-") ? "claude.exe" : "claude";
  const claudePath = path.join(SIDECAR_NODE_MODULES, ...platformPkg.split("/"), claudeBinName);
  if (!existsSync(claudePath)) {
    fail(
      `expected native sidecar executable missing for target ${target}: ${claudePath}. ` +
        `The pnpm supportedArchitectures injection did not materialise ${platformPkg}.`,
    );
  }
  let claudeSize = 0;
  try {
    claudeSize = statSync(claudePath).size;
  } catch (err) {
    fail(`could not stat ${claudePath}`, err);
  }
  if (claudeSize === 0) {
    fail(`native sidecar executable is empty: ${claudePath}`);
  }
  log(`target platform package OK: ${platformPkg} (${claudeBinName}, ${formatBytes(claudeSize)})`);

  const scopeDir = path.join(SIDECAR_NODE_MODULES, "@anthropic-ai");
  const expectedPlatformDir = platformPkg.split("/")[1];
  let scopeEntries = [];
  try {
    scopeEntries = readdirSync(scopeDir);
  } catch (err) {
    fail(`could not read ${scopeDir}`, err);
  }
  const foreign = scopeEntries.filter(
    (name) => /^claude-agent-sdk-/.test(name) && name !== expectedPlatformDir,
  );
  if (foreign.length > 0) {
    fail(
      `foreign claude-agent-sdk platform package(s) present for target ${target}: ` +
        `${foreign.join(", ")} (expected only ${expectedPlatformDir}). ` +
        `The bundle would ship the wrong native sidecar.`,
    );
  }
  log(`no foreign claude-agent-sdk platform packages present`);

  log(
    `NOTE: devDependencies (typescript, @types/node) were removed. ` +
      `Run 'pnpm sidecar:install' to restore them for dev work.`,
  );
}

main();
