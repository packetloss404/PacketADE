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

// 1. Detach any attached PacketADE scratch images. `hdiutil info` groups each
//    image into a block separated by a line of "=", with the `image-path` line
//    appearing BEFORE the `/dev/diskN` device line(s) inside that block. So we
//    flag a block when its image-path matches a PacketADE scratch image, then
//    force-detach the first whole-disk device that follows in that same block.
const info = sh("hdiutil info");
let blockIsOurs = false;
let detached = 0;
for (const line of info.split("\n")) {
  if (/^=+$/.test(line.trim())) {
    blockIsOurs = false; // new image block
    continue;
  }
  if (/image-path\s*:.*rw\.\d+\.PacketADE/i.test(line)) {
    blockIsOurs = true;
    continue;
  }
  const devMatch = line.match(/^(\/dev\/disk\d+)\b/);
  if (devMatch && blockIsOurs) {
    if (sh(`hdiutil detach ${devMatch[1]} -force`)) {
      console.log(`[clean-dmg-scratch] detached ${devMatch[1]}`);
      detached++;
    }
    blockIsOurs = false; // one detach per block
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
