#!/usr/bin/env node
/**
 * node-runtime.js
 *
 * Single source of truth for the Node.js runtime that ships inside the
 * PacketBench installer as a Tauri `externalBin` sidecar: which version, which
 * dist archive per Rust target triple, and — critically — the SHA-256 digest
 * each archive must have.
 *
 * ## Why the digests are pinned here
 *
 * `SHASUMS256.txt` is fetched from the same host, over the same channel, as
 * the archive it is supposed to authenticate. Anyone able to redirect or
 * intercept one fetch can redirect both and serve a self-consistent
 * archive/digest pair; the trojaned `node` binary would then be embedded in a
 * code-signed installer. Fetching the digest list therefore proves only
 * integrity-in-transit, never authenticity.
 *
 * These constants are the trust anchor instead. `fetch-node.js` verifies every
 * download against them, treats the live `SHASUMS256.txt` as an advisory
 * cross-check, and re-validates the on-disk `.sha256` cache marker against them
 * on every run so a single poisoned fetch cannot persist. `release-gate.mjs`
 * re-checks the staged binary against the same marker before a bundle ships.
 *
 * ## Provenance of the pinned digests (Node 24.15.0)
 *
 * Recorded 2026-08-06 from `https://nodejs.org/dist/v24.15.0/SHASUMS256.txt`,
 * verified with GPG against `SHASUMS256.txt.sig`:
 *
 *     gpg: Good signature from "Antoine du Hamel <antoine.duhamel@platformatic.dev>"
 *     Primary key fingerprint: 5BE8 A3F6 C8A5 C01D 106C  0AD8 20B1 A390 B168 D356
 *
 * The signing key was fetched from `github.com/nodejs/release-keys` — a
 * different host than the digests — so the signature is a genuine cross-channel
 * check rather than a self-referential one. The `x86_64-pc-windows-msvc` digest
 * additionally matches the marker written by an unrelated fetch on 2026-05-12.
 *
 * ## Updating Node
 *
 * Bumping `NODE_VERSION` REQUIRES replacing all five digests in the same
 * commit, obtained the same way:
 *
 *     curl -fsSLO https://nodejs.org/dist/v<VER>/SHASUMS256.txt
 *     curl -fsSLO https://nodejs.org/dist/v<VER>/SHASUMS256.txt.sig
 *     gpg --verify SHASUMS256.txt.sig SHASUMS256.txt   # must say "Good signature"
 *
 * A version bump with stale digests fails the build loudly, which is the
 * intent: adopting a new runtime is a reviewed commit, not a silent
 * trust-on-first-use.
 *
 * Pure module: no fs, no network, no process mutation.
 */

import { SUPPORTED_TRIPLES } from "./target-triple.js";

/** Pinned Node.js version bundled with the app. */
export const NODE_VERSION = "24.15.0";

export const NODE_DIST_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;
export const NODE_SHASUMS_URL = `${NODE_DIST_BASE}/SHASUMS256.txt`;

/**
 * Hostnames `fetch-node.js` is willing to talk to, including across redirects.
 * `nodejs.org` currently serves dist files directly through Cloudflare with no
 * redirect; the extra hosts are the mirrors the project has historically
 * bounced through.
 */
export const NODE_DIST_ALLOWED_HOSTS = Object.freeze([
  "nodejs.org",
  "direct.nodejs.org",
  "cdn.nodejs.org",
]);

/** Maximum redirect hops before `fetch-node.js` gives up. */
export const NODE_DIST_MAX_REDIRECTS = 5;

/**
 * Per-triple fetch/extract descriptors.
 *
 * Fields:
 *   distBasename    — Node.js dist archive filename (URL + SHASUMS lookup key)
 *   archiveSha256   — REVIEWED, PINNED digest of that archive (see header)
 *   archive         — "zip" | "tar.gz"
 *   innerBinaryPath — path within the archive to the node binary
 *   outputFilename  — filename under src-tauri/binaries/
 *                     (Tauri externalBin convention: <base>-<triple>[.exe])
 */
export const NODE_TARGETS = Object.freeze({
  "x86_64-pc-windows-msvc": {
    distBasename: `node-v${NODE_VERSION}-win-x64.zip`,
    archiveSha256: "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62",
    archive: "zip",
    innerBinaryPath: `node-v${NODE_VERSION}-win-x64/node.exe`,
    outputFilename: "node-x86_64-pc-windows-msvc.exe",
  },
  "x86_64-apple-darwin": {
    distBasename: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    archiveSha256: "ffd5ee293467927f3ee731a553eb88fd1f48cf74eebc2d74a6babe4af228673b",
    archive: "tar.gz",
    innerBinaryPath: `node-v${NODE_VERSION}-darwin-x64/bin/node`,
    outputFilename: "node-x86_64-apple-darwin",
  },
  "aarch64-apple-darwin": {
    distBasename: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    archiveSha256: "372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4",
    archive: "tar.gz",
    innerBinaryPath: `node-v${NODE_VERSION}-darwin-arm64/bin/node`,
    outputFilename: "node-aarch64-apple-darwin",
  },
  "x86_64-unknown-linux-gnu": {
    distBasename: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    archiveSha256: "44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89",
    archive: "tar.gz",
    innerBinaryPath: `node-v${NODE_VERSION}-linux-x64/bin/node`,
    outputFilename: "node-x86_64-unknown-linux-gnu",
  },
  "aarch64-unknown-linux-gnu": {
    distBasename: `node-v${NODE_VERSION}-linux-arm64.tar.gz`,
    archiveSha256: "73afc234d558c24919875f51c2d1ea002a2ada4ea6f83601a383869fefa64eed",
    archive: "tar.gz",
    innerBinaryPath: `node-v${NODE_VERSION}-linux-arm64/bin/node`,
    outputFilename: "node-aarch64-unknown-linux-gnu",
  },
});

// Drift guard: the descriptors must cover exactly the triples the shared
// resolver supports, and every one must carry a plausible pinned digest.
{
  const local = Object.keys(NODE_TARGETS).sort().join(",");
  const shared = [...SUPPORTED_TRIPLES].sort().join(",");
  if (local !== shared) {
    throw new Error(
      `node-runtime.js NODE_TARGETS has drifted from SUPPORTED_TRIPLES in ` +
        `target-triple.js (local: ${local}; shared: ${shared})`,
    );
  }
  for (const [triple, entry] of Object.entries(NODE_TARGETS)) {
    if (!/^[0-9a-f]{64}$/.test(entry.archiveSha256)) {
      throw new Error(
        `node-runtime.js: archiveSha256 for ${triple} is not a 64-char lowercase ` +
          `hex sha256 (got ${JSON.stringify(entry.archiveSha256)})`,
      );
    }
  }
}

/**
 * Reject any URL that is not HTTPS on an allow-listed Node.js dist host.
 *
 * `fetch-node.js` applies this to the initial request AND to every redirect
 * hop, so a `Location` header cannot walk a download off to an
 * attacker-controlled origin. Returns the normalised href.
 */
export function assertNodeDistUrl(url, context = "fetch-node") {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${context}: '${url}' is not a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${context}: refusing non-https URL ${parsed.href}`);
  }
  if (!NODE_DIST_ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new Error(
      `${context}: refusing host '${parsed.hostname}' — allowed hosts are ` +
        `${NODE_DIST_ALLOWED_HOSTS.join(", ")}`,
    );
  }
  return parsed.href;
}

function entryFor(triple) {
  const entry = NODE_TARGETS[triple];
  if (!entry) {
    throw new Error(
      `no bundled Node descriptor for target '${triple}'. ` +
        `Supported targets: ${Object.keys(NODE_TARGETS).join(", ")}`,
    );
  }
  return entry;
}

/** The reviewed, pinned SHA-256 of the dist archive for `triple`. */
export function nodeArchiveSha256(triple) {
  return entryFor(triple).archiveSha256;
}

/**
 * Repo-relative path of the staged runtime for `triple`, using forward slashes
 * so it can be printed and `path.join`ed on any platform.
 */
export function nodeBinaryRelPath(triple) {
  return `src-tauri/binaries/${entryFor(triple).outputFilename}`;
}
