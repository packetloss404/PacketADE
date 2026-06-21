#!/usr/bin/env node
/**
 * Reliable macOS build wrapper.
 *
 * `tauri build`'s DMG step (`bundle_dmg.sh`) runs a cosmetic "Finder-prettifying"
 * AppleScript (`osascript` → `tell application "Finder"`) to arrange the DMG
 * window. That step is flaky: it intermittently fails (the script even ships a
 * `-1728` "Can't get disk" workaround) and, when it does, abandons its mounted
 * read-write scratch image and aborts the whole build. In practice it fails on
 * roughly half of first attempts here and reliably succeeds on a clean retry.
 *
 * This wrapper makes the build deterministic: run the full build once; if it
 * fails, detach the leaked scratch image, then retry just the DMG bundling a
 * couple of times. The Rust release artifacts are cached, so retries are cheap
 * (the app is already compiled).
 *
 * Usage: `node scripts/build-macos.mjs [extra tauri build args]`
 * macOS-only; on other platforms it just runs `tauri build` straight through.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dmgDir = join(repoRoot, "src-tauri/target/release/bundle/dmg");
const passthrough = process.argv.slice(2);

function run(args) {
  execFileSync("pnpm", ["tauri", "build", ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function cleanScratch() {
  try {
    execSync("node scripts/clean-dmg-scratch.mjs", {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch {
    // best-effort
  }
}

function dmgExists() {
  try {
    return readdirSync(dmgDir).some((f) => f.endsWith(".dmg"));
  } catch {
    return false;
  }
}

// Non-macOS: nothing to work around.
if (process.platform !== "darwin") {
  run(passthrough);
  process.exit(0);
}

const MAX_DMG_RETRIES = 2;

try {
  run(passthrough);
} catch {
  console.warn(
    "\n[build-macos] tauri build failed (likely the DMG Finder AppleScript). Retrying DMG bundling...",
  );
  let ok = false;
  for (let attempt = 1; attempt <= MAX_DMG_RETRIES; attempt++) {
    cleanScratch();
    console.warn(`[build-macos] DMG retry ${attempt}/${MAX_DMG_RETRIES}...`);
    try {
      run(["--bundles", "dmg"]);
      ok = true;
      break;
    } catch {
      console.warn(`[build-macos] retry ${attempt} failed.`);
    }
  }
  if (!ok) {
    console.error(
      "[build-macos] DMG bundling still failing after retries. See output above.",
    );
    process.exit(1);
  }
}

if (!dmgExists()) {
  console.error(`[build-macos] build reported success but no .dmg in ${dmgDir}`);
  process.exit(1);
}

// Detach any scratch image left mounted by an intermediate failed attempt so we
// leave a clean state (and don't have a stray volume lingering on the desktop).
cleanScratch();

console.log("[build-macos] build complete — DMG present.");
