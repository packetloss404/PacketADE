#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const reportOnly = args.has("--report-only");

const requiredQualityScripts = [
  ["format:check", "pnpm run format:check"],
  ["lint:src", "pnpm run lint:src"],
  ["test", "pnpm test"],
  ["build", "pnpm run build"],
  ["e2e", "pnpm run e2e"],
  ["sidecar:check", "pnpm run sidecar:check"],
  ["check:tauri-schema", "pnpm run check:tauri-schema"],
  ["rust:check", "pnpm run rust:check"],
  ["rust:test", "pnpm run rust:test"],
  ["check", "pnpm run check"],
];

const artifactGlobsByTarget = {
  windows: [
    "src-tauri/target/release/bundle/nsis/*setup.exe",
    "src-tauri/target/release/bundle/msi/*.msi",
  ],
  macos: ["src-tauri/target/release/bundle/dmg/*.dmg"],
  linux: [
    "src-tauri/target/release/bundle/deb/*.deb",
    "src-tauri/target/release/bundle/appimage/*.AppImage",
  ],
};

function readJson(relativePath) {
  const absolutePath = path.join(root, relativePath);
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

function envPresent(names) {
  return names.filter((name) => Boolean(process.env[name]));
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function hostTarget() {
  switch (os.platform()) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

function findFiles(globPattern) {
  const normalized = globPattern.replaceAll("\\", "/");
  const wildcardIndex = normalized.indexOf("*");
  if (wildcardIndex === -1) {
    const absolutePath = path.join(root, normalized);
    return existsSync(absolutePath) ? [normalized] : [];
  }

  const directory = normalized.slice(0, wildcardIndex);
  const filePattern = normalized.slice(wildcardIndex);
  const directoryPath = path.join(root, directory);
  if (!existsSync(directoryPath)) return [];

  const suffix = filePattern.slice(1);
  return readdirSync(directoryPath)
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => path.posix.join(directory, entry));
}

function latestByMtime(files) {
  return files
    .map((file) => ({
      file,
      mtimeMs: statSync(path.join(root, file)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ file }) => file);
}

function printSection(title, items) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
  for (const item of items) {
    const suffix = item.detail ? ` - ${item.detail}` : "";
    console.log(`[${item.status}] ${item.label}${suffix}`);
  }
}

const packageJson = readJson("package.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const releaseVersion = String(packageJson.version ?? "").trim();
const scripts = packageJson.scripts ?? {};
const bundle = tauriConfig.bundle ?? {};
const macosBundle = bundle.macOS ?? {};
const windowsBundle = bundle.windows ?? {};
const updaterConfig = tauriConfig.plugins?.updater ?? {};
const target = process.env.PACKETADE_RELEASE_TARGET || hostTarget();

const metadata = [
  {
    status: packageJson.version === tauriConfig.version ? "PASS" : "FAIL",
    label: "package.json version matches tauri.conf.json",
    detail: `${packageJson.version} / ${tauriConfig.version}`,
  },
  {
    status: bundle.active ? "PASS" : "FAIL",
    label: "Tauri bundle output is enabled",
    detail: `bundle.active=${String(bundle.active)}`,
  },
  {
    status: bundle.targets ? "PASS" : "FAIL",
    label: "Tauri bundle targets are configured",
    detail: `targets=${JSON.stringify(bundle.targets)}`,
  },
];

const windowsSigningSignals = [
  windowsBundle.certificateThumbprint,
  windowsBundle.certificatePath,
  windowsBundle.signCommand,
  ...envPresent([
    "WINDOWS_CERTIFICATE_THUMBPRINT",
    "WINDOWS_CERTIFICATE_PATH",
    "WINDOWS_CODESIGN_CERTIFICATE_PATH",
    "TAURI_BUNDLER_SIGN_COMMAND",
    "TAURI_SIGNTOOL_PATH",
  ]),
];

const macosSigningSignals = [
  macosBundle.signingIdentity,
  macosBundle.providerShortName,
  ...envPresent([
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PATH",
  ]),
];

const macosNotarySignals = envPresent([
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_PATH",
]);

const updaterSigningSignals = envPresent([
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
]);

const signing = [
  {
    status: windowsSigningSignals.some(hasValue) ? "PASS" : "WARN",
    label: "Windows Authenticode signing signal",
    detail: windowsSigningSignals.some(hasValue)
      ? "config/env present"
      : "no signing identity signal found",
  },
  {
    status: macosSigningSignals.some(hasValue) ? "PASS" : "WARN",
    label: "macOS code-signing signal",
    detail: macosSigningSignals.some(hasValue)
      ? "config/env present"
      : "no Developer ID signal found",
  },
  {
    status: macosNotarySignals.length >= 2 ? "PASS" : "WARN",
    label: "macOS notarization signal",
    detail: macosNotarySignals.length
      ? `${macosNotarySignals.join(", ")} present`
      : "no notarization env signal found",
  },
  {
    status: updaterSigningSignals.length === 2 ? "PASS" : "WARN",
    label: "Tauri updater signing env",
    detail:
      updaterSigningSignals.length === 2
        ? "private key and password env present"
        : "TAURI_SIGNING_PRIVATE_KEY and password not both present",
  },
];

const manifestCandidates = [
  process.env.PACKETADE_UPDATER_MANIFEST,
  "src-tauri/target/release/bundle/latest.json",
  "src-tauri/target/release/bundle/nsis/latest.json",
  "src-tauri/target/release/bundle/dmg/latest.json",
].filter(Boolean);

const existingManifest = manifestCandidates.find((candidate) =>
  existsSync(path.join(root, candidate)),
);

let manifestDetail = "no latest.json found in known bundle locations";
let manifestStatus = "WARN";
if (existingManifest) {
  try {
    const manifest = readJson(existingManifest);
    const hasRequiredFields =
      Boolean(manifest.version) &&
      Boolean(manifest.pub_date) &&
      typeof manifest.platforms === "object";
    manifestStatus = hasRequiredFields ? "PASS" : "FAIL";
    manifestDetail = hasRequiredFields
      ? existingManifest
      : `${existingManifest} is missing version, pub_date, or platforms`;
  } catch (error) {
    manifestStatus = "FAIL";
    manifestDetail = `${existingManifest} is not valid JSON: ${error.message}`;
  }
}

const updater = [
  {
    status:
      updaterConfig.active &&
      hasValue(updaterConfig.pubkey) &&
      Array.isArray(updaterConfig.endpoints) &&
      updaterConfig.endpoints.length > 0
        ? "PASS"
        : "WARN",
    label: "Tauri updater config",
    detail:
      updaterConfig.active === true
        ? "plugins.updater is active"
        : "plugins.updater is not active in tauri.conf.json",
  },
  {
    status: manifestStatus,
    label: "Updater manifest",
    detail: manifestDetail,
  },
];

const artifactPatterns =
  artifactGlobsByTarget[target] ?? Object.values(artifactGlobsByTarget).flat();
const allArtifacts = latestByMtime(artifactPatterns.flatMap(findFiles));
const artifacts = allArtifacts.filter((file) => path.basename(file).includes(releaseVersion));
const artifactSection = [
  {
    status: artifacts.length > 0 ? "PASS" : "FAIL",
    label: `Bundle artifacts for ${target}`,
    detail: artifacts.length
      ? artifacts.slice(0, 4).join(", ")
      : allArtifacts.length
        ? `found artifacts, but none match version ${releaseVersion}: ${allArtifacts.slice(0, 4).join(", ")}`
        : `expected version ${releaseVersion} artifact from one of ${artifactPatterns.join(", ")}`,
  },
];

const gates = requiredQualityScripts.map(([scriptName, command]) => ({
  status: scripts[scriptName] ? "PASS" : "FAIL",
  label: command,
  detail: scripts[scriptName]
    ? `package script "${scriptName}" is defined`
    : `package script "${scriptName}" is missing`,
}));

const sections = [
  ["Release Metadata", metadata],
  ["Signing Signals", signing],
  ["Updater Readiness", updater],
  ["Bundle Artifacts", artifactSection],
  ["Required Quality Gates", gates],
];

console.log("PacketADE Release Readiness");
console.log(`Target: ${target}`);
console.log(`Mode: ${reportOnly ? "report-only" : "gate"}`);

for (const [title, items] of sections) {
  printSection(title, items);
}

const allItems = sections.flatMap(([, items]) => items);
const failCount = allItems.filter((item) => item.status === "FAIL").length;
const warnCount = allItems.filter((item) => item.status === "WARN").length;

console.log(`\nSummary: ${failCount} fail, ${warnCount} warn`);

if (failCount > 0 && !reportOnly) {
  process.exit(1);
}
