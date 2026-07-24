#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { resolveTarget, sidecarPlatformPackage } from "./target-triple.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const requireClean =
  args.has("--require-clean") || process.env.PACKETADE_RELEASE_REQUIRE_CLEAN === "1";
const requireSigning =
  args.has("--require-signing") || process.env.PACKETADE_RELEASE_REQUIRE_SIGNING === "1";
const requireUpdater =
  args.has("--require-updater") || process.env.PACKETADE_RELEASE_REQUIRE_UPDATER === "1";

const checks = [];

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function pass(name, detail = "") {
  checks.push({ ok: true, name, detail });
}

function fail(name, detail) {
  checks.push({ ok: false, name, detail });
}

function warn(name, detail) {
  checks.push({ ok: null, name, detail });
}

function envAny(names) {
  return names.some((name) => process.env[name]?.trim());
}

function envAll(names) {
  return names.every((name) => process.env[name]?.trim());
}

const pkg = readJson("package.json");
const tauri = readJson("src-tauri/tauri.conf.json");
const cargo = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;

if (pkg.version === tauri.version && pkg.version === cargoVersion) {
  pass("Version alignment", `package.json, tauri.conf.json, and Cargo.toml are ${pkg.version}`);
} else {
  fail(
    "Version alignment",
    `package=${pkg.version}, tauri=${tauri.version}, cargo=${cargoVersion ?? "(missing)"}`,
  );
}

if (tauri.bundle?.active === true) {
  pass("Tauri bundling enabled");
} else {
  fail("Tauri bundling enabled", "src-tauri/tauri.conf.json bundle.active must be true");
}

const beforeBuild = String(tauri.build?.beforeBuildCommand ?? "");
if (beforeBuild.includes("prebundle") && beforeBuild.includes("build")) {
  pass("Before-build pipeline", beforeBuild);
} else {
  fail("Before-build pipeline", "beforeBuildCommand should run prebundle and frontend build");
}

const resources = tauri.bundle?.resources ?? {};
const resourceValues = Object.values(resources).join("\n");
if (
  resourceValues.includes("agent-sidecar/dist") &&
  resourceValues.includes("agent-sidecar/node_modules")
) {
  pass("Sidecar resources bundled");
} else {
  fail(
    "Sidecar resources bundled",
    "agent-sidecar dist and node_modules must be included as resources",
  );
}

if (
  Array.isArray(tauri.bundle?.externalBin) &&
  tauri.bundle.externalBin.includes("binaries/node")
) {
  pass("Bundled Node runtime configured");
} else {
  fail("Bundled Node runtime configured", "bundle.externalBin must include binaries/node");
}

if (exists("agent-sidecar/dist/index.js")) {
  pass("Sidecar dist exists", "agent-sidecar/dist/index.js");
} else {
  fail("Sidecar dist exists", "Run pnpm run prebundle or pnpm run sidecar:build before packaging");
}

// Cross-arch consistency: the staged Node runtime and the installed sidecar
// native platform package must both match the resolved build target.
let releaseTarget = null;
try {
  releaseTarget = resolveTarget({ argv: process.argv, env: process.env });
  pass("Build target resolved", releaseTarget);
} catch (err) {
  fail("Build target resolved", err instanceof Error ? err.message : String(err));
}

if (releaseTarget) {
  const isWindowsTarget = releaseTarget.includes("-windows-");
  const platformPkg = sidecarPlatformPackage(releaseTarget);
  const platformDirName = platformPkg.split("/")[1];
  const claudeRel = path.join(
    "agent-sidecar",
    "node_modules",
    "@anthropic-ai",
    platformDirName,
    isWindowsTarget ? "claude.exe" : "claude",
  );
  const claudeAbs = path.join(root, claudeRel);
  if (fs.existsSync(claudeAbs) && fs.statSync(claudeAbs).size > 0) {
    pass("Sidecar native platform package matches target", `${platformPkg} (${claudeRel})`);
  } else {
    fail(
      "Sidecar native platform package matches target",
      `${claudeRel} missing or empty — run pnpm run sidecar:prune for target ${releaseTarget}`,
    );
  }

  const scopeAbs = path.join(root, "agent-sidecar", "node_modules", "@anthropic-ai");
  let foreign = [];
  try {
    foreign = fs
      .readdirSync(scopeAbs)
      .filter((name) => /^claude-agent-sdk-/.test(name) && name !== platformDirName);
  } catch (err) {
    fail(
      "No foreign sidecar platform packages",
      `could not read ${scopeAbs}: ${err instanceof Error ? err.message : String(err)}`,
    );
    foreign = null;
  }
  if (foreign !== null) {
    if (foreign.length === 0) {
      pass("No foreign sidecar platform packages");
    } else {
      fail(
        "No foreign sidecar platform packages",
        `found ${foreign.join(", ")} alongside target ${releaseTarget} — the bundle would ship the wrong native sidecar`,
      );
    }
  }

  const nodeRel = `src-tauri/binaries/node-${releaseTarget}${isWindowsTarget ? ".exe" : ""}`;
  if (exists(nodeRel)) {
    pass("Target Node runtime fetched", nodeRel);
  } else {
    fail("Target Node runtime fetched", `${nodeRel} missing — run pnpm run fetch-node for ${releaseTarget}`);
  }
}

if (exists("dev/updater-setup.md")) {
  pass("Updater runbook present", "dev/updater-setup.md");
} else {
  warn("Updater runbook present", "dev/updater-setup.md is missing");
}

if (requireClean) {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (status.length === 0) pass("Git tree clean");
    else fail("Git tree clean", status.split("\n").slice(0, 12).join("\n"));
  } catch (err) {
    fail("Git tree clean", err instanceof Error ? err.message : String(err));
  }
}

if (requireSigning) {
  const windowsSigning = envAny([
    "WINDOWS_SIGNTOOL_CERT_SHA1",
    "WINDOWS_SIGNING_CERT_PATH",
    "TAURI_SIGNING_PRIVATE_KEY",
  ]);
  const macSigning = envAny([
    "APPLE_SIGNING_IDENTITY",
    "APPLE_CERTIFICATE",
    "APPLE_API_KEY",
    "APPLE_API_KEY_PATH",
  ]);
  if (windowsSigning || macSigning) {
    pass(
      "Signing credentials present",
      "Found at least one Windows or Apple signing credential hint",
    );
  } else {
    fail(
      "Signing credentials present",
      "Set WINDOWS_SIGNTOOL_CERT_SHA1/WINDOWS_SIGNING_CERT_PATH or Apple signing env before a trusted beta",
    );
  }
}

if (requireUpdater) {
  const updater = tauri.plugins?.updater ?? {};
  const updaterConfigReady =
    updater.active === true &&
    typeof updater.pubkey === "string" &&
    updater.pubkey.trim().length > 0 &&
    Array.isArray(updater.endpoints) &&
    updater.endpoints.length > 0;
  const updaterSecretReady = envAll([
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ]);

  if (updaterConfigReady && updaterSecretReady) {
    pass("Updater signing configured");
  } else {
    fail(
      "Updater signing configured",
      "Updater beta requires active plugins.updater config with pubkey/endpoints plus TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD env",
    );
  }
}

let failed = 0;
let warned = 0;
for (const check of checks) {
  const marker = check.ok === true ? "PASS" : check.ok === false ? "FAIL" : "WARN";
  if (check.ok === false) failed += 1;
  if (check.ok === null) warned += 1;
  const detail = check.detail ? ` - ${check.detail}` : "";
  console.log(`${marker} ${check.name}${detail}`);
}

if (failed > 0) {
  console.error(`\nRelease gate failed: ${failed} failed, ${warned} warning(s).`);
  process.exit(1);
}

console.log(`\nRelease gate passed: ${checks.length - warned} checks, ${warned} warning(s).`);
