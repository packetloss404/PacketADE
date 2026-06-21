#!/usr/bin/env node
/**
 * Pre-build cleanup for the macOS DMG bundler.
 *
 * `bundle_dmg.sh` (invoked by `tauri build`) creates a read-write scratch disk
 * image — `rw.<pid>.PacketADE_<ver>_<arch>.dmg` — mounts it, copies the app in,
 * then converts + detaches. If a previous run was interrupted (or its detach
 * failed), that scratch image stays *attached*, and the next bundle run trips
 * over it with: "failed to run bundle_dmg.sh". We hit this on ~half our local
 * builds.
 *
 * This script runs before the build and clears the wreckage: detach any attached
 * PacketADE scratch images and delete leftover `rw.*.dmg` files. macOS-only;
 * a no-op everywhere else.
 */
import { execSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.platform !== "darwin") {
  process.exit(0);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const macosBundleDir = join(
  repoRoot,
  "src-tauri/target/release/bundle/macos",
);

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8" });
  } catch {
    return "";
  }
}

// 1. Detach any attached PacketADE scratch images. `hdiutil info` lists each
//    attached image as a "/dev/diskN ... <image-path>" block; pair the device
//    node with its image path and force-detach the PacketADE ones.
const info = sh("hdiutil info");
let currentDev = null;
let detached = 0;
for (const line of info.split("\n")) {
  const devMatch = line.match(/^(\/dev\/disk\d+)/);
  if (devMatch) currentDev = devMatch[1];
  if (/rw\.\d+\.PacketADE/i.test(line) && currentDev) {
    if (sh(`hdiutil detach ${currentDev} -force`)) {
      console.log(`[clean-dmg-scratch] detached ${currentDev}`);
      detached++;
    }
    currentDev = null;
  }
}

// 2. Remove leftover scratch images from the bundle dir.
let removed = 0;
try {
  for (const name of readdirSync(macosBundleDir)) {
    if (/^rw\.\d+\.PacketADE.*\.dmg$/i.test(name)) {
      rmSync(join(macosBundleDir, name), { force: true });
      removed++;
    }
  }
} catch {
  // bundle dir may not exist yet on a clean checkout — nothing to clean.
}

if (detached || removed) {
  console.log(
    `[clean-dmg-scratch] cleaned ${detached} attached image(s), ${removed} scratch file(s)`,
  );
}
