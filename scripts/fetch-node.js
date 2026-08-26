#!/usr/bin/env node
/**
 * fetch-node.js
 *
 * Downloads a pinned Node.js runtime and stages it as a Tauri `externalBin`
 * sidecar under `src-tauri/binaries/`. Used as part of the build pipeline so
 * the packaged app ships with its own `node` binary for the agent sidecar
 * runtime.
 *
 * Supports multiple Rust targets (Tauri `externalBin` triple-suffix convention):
 *   - x86_64-pc-windows-msvc        (win-x64,    zip)
 *   - x86_64-apple-darwin           (darwin-x64, tar.gz)
 *   - aarch64-apple-darwin          (darwin-arm64, tar.gz)
 *   - x86_64-unknown-linux-gnu      (linux-x64,  tar.gz)
 *   - aarch64-unknown-linux-gnu     (linux-arm64, tar.gz)
 *
 * Target selection (in priority order):
 *   1. CLI `--target=<triple>` or `--all-targets`
 *   2. Env `TAURI_ENV_TARGET_TRIPLE=<triple>` (injected by Tauri)
 *   3. Env `TAURI_TARGET=<triple>` (manual override)
 *   4. Host detection from `process.platform` + `process.arch`
 *
 * Authenticity: every archive is verified against a reviewed SHA-256 digest
 * pinned in `scripts/node-runtime.js`, NOT against the digest list served
 * alongside it. The live `SHASUMS256.txt` is fetched only as an advisory
 * cross-check and can never relax the pinned value. See that file's header for
 * why, and for how to rotate the pins when bumping Node.
 *
 * Idempotent: if the target binary already exists and its sibling `.sha256`
 * marker records the same nodeVersion + target + pinned archive digest + a
 * matching on-disk sha256, the download is skipped. The marker is re-validated
 * against the pinned digest on every run, so a cache poisoned by one bad fetch
 * does not survive.
 *
 * Node 18+ (uses ESM + node: prefixed stdlib imports). Requires `adm-zip`
 * (for zip) and `tar` (for tar.gz).
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  createWriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

import AdmZip from "adm-zip";
import * as tar from "tar";

import { resolveTarget } from "./target-triple.js";
import {
  assertNodeDistUrl,
  NODE_DIST_BASE,
  NODE_DIST_MAX_REDIRECTS,
  NODE_SHASUMS_URL,
  NODE_TARGETS,
  NODE_VERSION,
} from "./node-runtime.js";

// ---------------------------------------------------------------------------
// Pinned constants (see scripts/node-runtime.js)
// ---------------------------------------------------------------------------

const SHASUMS_URL = NODE_SHASUMS_URL;
const DIST_BASE = NODE_DIST_BASE;
const TARGETS = NODE_TARGETS;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_DIR = path.resolve(__dirname, "../src-tauri/binaries");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Follow redirects and fetch a URL. Resolves with a Buffer for small payloads
 * (SHASUMS256.txt) or streams to a write stream for large payloads.
 *
 * Redirects are constrained two ways: the destination must stay on an
 * allow-listed Node.js dist host, and `depth` caps the hop count so a redirect
 * loop terminates instead of recursing until the stack blows.
 */
function httpsGet(url, onResponse, depth = 0) {
  return new Promise((resolve, reject) => {
    let safeUrl;
    try {
      safeUrl = assertNodeDistUrl(url, "fetch-node");
    } catch (err) {
      reject(err);
      return;
    }
    const req = https.get(safeUrl, (res) => {
      // Handle redirects (nodejs.org has historically used them for cdn/mirrors)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (depth >= NODE_DIST_MAX_REDIRECTS) {
          reject(
            new Error(
              `GET ${safeUrl} exceeded ${NODE_DIST_MAX_REDIRECTS} redirects ` +
                `(last hop pointed at ${res.headers.location})`,
            ),
          );
          return;
        }
        let next;
        try {
          next = assertNodeDistUrl(new URL(res.headers.location, safeUrl).toString(), "fetch-node");
        } catch (err) {
          reject(err);
          return;
        }
        httpsGet(next, onResponse, depth + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(
          new Error(
            `GET ${safeUrl} failed with status ${res.statusCode} ${res.statusMessage ?? ""}`,
          ),
        );
        return;
      }
      try {
        onResponse(res, resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error(`Request to ${safeUrl} timed out after 120s`));
    });
  });
}

/** Fetch a small text/binary response into a Buffer. */
function fetchBuffer(url) {
  return httpsGet(url, (res, resolve, reject) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

/** Stream a response into a file on disk. */
function downloadToFile(url, destPath) {
  return httpsGet(url, (res, resolve, reject) => {
    const out = createWriteStream(destPath);
    res.pipe(out);
    out.on("finish", () => out.close(() => resolve(destPath)));
    out.on("error", (err) => {
      out.close(() => reject(err));
    });
    res.on("error", reject);
  });
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256File(filePath) {
  return sha256Hex(readFileSync(filePath));
}

/**
 * Parse SHASUMS256.txt — each line is `<hex>  <filename>`. Returns the hex
 * digest for the given basename, or `null` when absent.
 *
 * This list is advisory only: it arrives over the same channel as the archive
 * it describes, so it is used to cross-check the pinned digest, never to
 * supply one.
 */
function findShasum(shasumsText, basename) {
  const lines = shasumsText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 2) continue;
    if (parts[1] === basename) {
      return parts[0].toLowerCase();
    }
  }
  return null;
}

function fail(message, cause) {
  process.stderr.write(`fetch-node: ERROR ${message}\n`);
  if (cause) {
    process.stderr.write(`fetch-node: cause: ${cause.stack ?? cause}\n`);
  }
  process.exit(1);
}

function log(message) {
  process.stdout.write(`fetch-node: ${message}\n`);
}

function warn(message) {
  process.stderr.write(`fetch-node: WARNING ${message}\n`);
}

// ---------------------------------------------------------------------------
// Target selection (shared resolver in scripts/target-triple.js)
// ---------------------------------------------------------------------------
//
// The TARGETS-vs-SUPPORTED_TRIPLES drift guard now lives in node-runtime.js
// and runs at import, so release-gate.mjs gets the same protection.

function printHelp() {
  const supported = Object.keys(TARGETS)
    .map((t) => `    ${t}`)
    .join("\n");
  process.stdout.write(
    `Usage: node scripts/fetch-node.js [options]\n\n` +
      `Downloads a pinned Node.js runtime (v${NODE_VERSION}) for a Rust target\n` +
      `and places it under src-tauri/binaries/ using Tauri's externalBin\n` +
      `triple-suffix convention.\n\n` +
      `Options:\n` +
      `  --target=<triple>   Fetch the binary for a specific Rust target.\n` +
      `  --all-targets       Fetch binaries for every supported target (CI).\n` +
      `  --help              Show this help and exit.\n\n` +
      `Target selection (priority):\n` +
      `  1. --target / --all-targets CLI flag\n` +
      `  2. TAURI_ENV_TARGET_TRIPLE environment variable (injected by Tauri)\n` +
      `  3. TAURI_TARGET environment variable (manual override)\n` +
      `  4. Host-detected target (process.platform + process.arch)\n\n` +
      `Supported targets:\n${supported}\n`,
  );
}

function parseArgs(argv) {
  const out = { help: false, all: false, target: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--all-targets") {
      out.all = true;
    } else if (arg.startsWith("--target=")) {
      out.target = arg.slice("--target=".length);
    } else if (arg === "--target") {
      fail(`--target requires an argument; use --target=<triple>`);
    } else {
      fail(`unknown argument: ${arg}. Pass --help for usage.`);
    }
  }
  return out;
}

function resolveTargets(args) {
  if (args.all) {
    return Object.keys(TARGETS);
  }
  // Shared resolver: --target= → TAURI_ENV_TARGET_TRIPLE → TAURI_TARGET →
  // host detection; throws on unknown/undetectable/conflicting targets.
  try {
    return [resolveTarget({ argv: process.argv, env: process.env })];
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Decide whether the already-staged binary for `triple` can be trusted without
 * re-downloading.
 *
 * The marker is never taken at its word: it is only accepted when the archive
 * digest it records equals the digest pinned in node-runtime.js. That is what
 * stops the cache from being self-referential — a binary staged from a poisoned
 * download records the attacker's digest, which no longer matches the pin, so
 * it is discarded and re-fetched instead of being trusted forever.
 */
function cachedTargetStatus(triple) {
  const entry = TARGETS[triple];
  const outputPath = path.join(TARGET_DIR, entry.outputFilename);
  const markerPath = `${outputPath}.sha256`;

  if (!existsSync(outputPath)) {
    return { valid: false, outputPath, reason: "binary missing" };
  }
  if (!existsSync(markerPath)) {
    return { valid: false, outputPath, reason: "marker missing" };
  }

  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      !marker ||
      marker.nodeVersion !== NODE_VERSION ||
      marker.target !== triple ||
      typeof marker.sha256 !== "string"
    ) {
      return { valid: false, outputPath, reason: "marker is for a different version/layout" };
    }

    if (marker.archiveSha256 !== entry.archiveSha256) {
      return {
        valid: false,
        outputPath,
        reason:
          `staged binary came from an archive whose sha256 ` +
          `(${String(marker.archiveSha256).slice(0, 12)}...) does not match the ` +
          `pinned digest (${entry.archiveSha256.slice(0, 12)}...)`,
      };
    }

    const actual = sha256File(outputPath);
    if (actual !== marker.sha256) {
      return {
        valid: false,
        outputPath,
        reason: `existing binary sha256 mismatch (stored=${marker.sha256.slice(0, 12)}..., actual=${actual.slice(0, 12)}...)`,
      };
    }

    return { valid: true, outputPath };
  } catch (err) {
    return {
      valid: false,
      outputPath,
      reason: `could not parse .sha256 marker (${err.message})`,
    };
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract exactly one file from a zip archive, returning its contents as a
 * Buffer. Throws if the entry is missing or empty.
 */
function extractFromZip(archivePath, innerPath) {
  const zip = new AdmZip(archivePath);
  const entry = zip.getEntry(innerPath);
  if (!entry) {
    throw new Error(`zip does not contain expected entry ${innerPath}`);
  }
  const buf = entry.getData();
  if (!buf || buf.length === 0) {
    throw new Error(`extracted entry ${innerPath} is empty`);
  }
  return buf;
}

/**
 * Extract exactly one file from a tar.gz archive into `destDir`. Returns the
 * absolute path to the extracted file.
 *
 * We use `tar.x` with a filter so only the one entry we want is written to
 * disk — far cheaper than expanding a ~50 MB Node distribution.
 */
async function extractFromTarGz(archivePath, innerPath, destDir) {
  let matched = false;
  await tar.x({
    file: archivePath,
    cwd: destDir,
    // tar strips no components; the archive's top-level dir is preserved so
    // the extracted path is `<destDir>/<innerPath>`.
    filter: (p) => {
      // tar normalizes paths to forward slashes
      const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
      if (norm === innerPath) {
        matched = true;
        return true;
      }
      return false;
    },
  });
  if (!matched) {
    throw new Error(`tar archive does not contain expected entry ${innerPath}`);
  }
  const extracted = path.join(destDir, innerPath);
  if (!existsSync(extracted)) {
    throw new Error(`tar extraction reported match but ${extracted} is missing`);
  }
  return extracted;
}

// ---------------------------------------------------------------------------
// Per-target processor
// ---------------------------------------------------------------------------

async function processTarget(triple, shasumsText) {
  const entry = TARGETS[triple];
  const archiveUrl = `${DIST_BASE}/${entry.distBasename}`;
  const outputPath = path.join(TARGET_DIR, entry.outputFilename);
  const markerPath = `${outputPath}.sha256`;

  // The pinned digest is the trust anchor. The live SHASUMS list — fetched over
  // the same channel as the archive — is only ever a cross-check.
  const expectedArchiveSha = entry.archiveSha256;
  const upstreamSha = shasumsText ? findShasum(shasumsText, entry.distBasename) : null;
  if (upstreamSha === null) {
    warn(
      `[${triple}] no SHASUMS256.txt entry for ${entry.distBasename} to cross-check ` +
        `against; continuing on the pinned digest`,
    );
  } else if (upstreamSha !== expectedArchiveSha) {
    fail(
      `[${triple}] SHASUMS256.txt reports sha256 ${upstreamSha} for ` +
        `${entry.distBasename}, but scripts/node-runtime.js pins ` +
        `${expectedArchiveSha}. Either upstream was tampered with or the pin is ` +
        `stale — resolve this by hand (re-verify SHASUMS256.txt.sig with GPG) ` +
        `before building.`,
    );
  }

  const cached = cachedTargetStatus(triple);
  if (cached.valid) {
    log(`[${triple}] already present (v${NODE_VERSION}), skipping fetch`);
    reportOutcome(triple, outputPath, false);
    return;
  } else if (cached.reason !== "binary missing") {
    log(`[${triple}] ${cached.reason} — re-fetching`);
  }

  // Download + extract in a scratch dir.
  const workDir = path.join(
    tmpdir(),
    `packetbench-fetch-node-${triple}-${process.pid}-${Date.now()}`,
  );
  mkdirSync(workDir, { recursive: true });
  const archivePath = path.join(workDir, entry.distBasename);

  const cleanup = () => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // swallow — cleanup is best effort
    }
  };

  try {
    log(`[${triple}] downloading ${archiveUrl}`);
    await downloadToFile(archiveUrl, archivePath);

    const archiveSha = sha256File(archivePath);
    if (archiveSha !== expectedArchiveSha) {
      try {
        rmSync(archivePath, { force: true });
      } catch {
        // ignore
      }
      throw new Error(
        `downloaded archive sha256 ${archiveSha} does not match the digest ` +
          `pinned in scripts/node-runtime.js (${expectedArchiveSha})`,
      );
    }
    log(`[${triple}] archive sha256 verified against pinned digest`);

    log(`[${triple}] extracting ${entry.innerBinaryPath}`);
    let binaryBuf;
    if (entry.archive === "zip") {
      binaryBuf = extractFromZip(archivePath, entry.innerBinaryPath);
    } else if (entry.archive === "tar.gz") {
      const extractedPath = await extractFromTarGz(archivePath, entry.innerBinaryPath, workDir);
      binaryBuf = readFileSync(extractedPath);
      if (!binaryBuf || binaryBuf.length === 0) {
        throw new Error(`extracted binary buffer is empty`);
      }
    } else {
      throw new Error(`unsupported archive type: ${entry.archive}`);
    }

    // Ensure the binaries dir exists (caller should have already done it, but
    // be defensive when processing multiple targets sequentially).
    mkdirSync(TARGET_DIR, { recursive: true });

    // Atomic-ish write: write to a .tmp sibling then rename over.
    const tmpTarget = `${outputPath}.tmp`;
    try {
      rmSync(tmpTarget, { force: true });
    } catch {
      // ignore
    }
    writeFileSync(tmpTarget, binaryBuf);
    const writtenSha = sha256File(tmpTarget);

    try {
      rmSync(outputPath, { force: true });
    } catch {
      // ignore
    }
    renameSync(tmpTarget, outputPath);

    // Unix executable bit. Windows does not need / respect chmod.
    if (!triple.includes("-windows-")) {
      chmodSync(outputPath, 0o755);
    }

    const marker = {
      nodeVersion: NODE_VERSION,
      target: triple,
      archiveUrl,
      archiveBasename: entry.distBasename,
      archiveSha256: expectedArchiveSha,
      sha256: writtenSha,
      fetchedAt: new Date().toISOString(),
    };
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

    cleanup();
    reportOutcome(triple, outputPath, true);
  } catch (err) {
    try {
      rmSync(`${outputPath}.tmp`, { force: true });
    } catch {
      // ignore
    }
    cleanup();
    fail(`[${triple}] download/extract failed`, err);
  }
}

function reportOutcome(triple, outputPath, downloaded) {
  if (!existsSync(outputPath)) {
    fail(`[${triple}] post-condition: target ${outputPath} missing`);
  }
  const size = statSync(outputPath).size;
  const sha = sha256File(outputPath);
  log(
    `[${triple}] ${downloaded ? "downloaded" : "skipped"}  ` +
      `path=${outputPath}  size=${size}  sha256=${sha}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const triples = resolveTargets(args);
  log(`resolved targets: ${triples.join(", ")}`);

  mkdirSync(TARGET_DIR, { recursive: true });

  // Every staged binary is re-validated against the pinned archive digest here,
  // so a cache hit means "matches the reviewed pin", not merely "matches
  // whatever we recorded last time".
  const cachedStatuses = triples.map((triple) => [triple, cachedTargetStatus(triple)]);
  if (cachedStatuses.every(([, status]) => status.valid)) {
    log(`all requested targets already present and match pinned digests`);
    for (const [triple, status] of cachedStatuses) {
      reportOutcome(triple, status.outputPath, false);
    }
    return;
  }

  // Fetch SHASUMS256.txt once and reuse across all targets. This is a
  // cross-check against the pinned digests, not the source of them, so a
  // failure to fetch it is a warning rather than a hard stop — suppressing it
  // cannot help an attacker get a different archive past the pin.
  log(`fetching ${SHASUMS_URL} (cross-check)`);
  let shasumsText = null;
  try {
    shasumsText = (await fetchBuffer(SHASUMS_URL)).toString("utf8");
  } catch (err) {
    warn(
      `could not fetch SHASUMS256.txt (${err instanceof Error ? err.message : String(err)}); ` +
        `continuing with the pinned digests from scripts/node-runtime.js`,
    );
  }

  for (const triple of triples) {
    // Sequential — keeps network load friendly and logs readable.
    await processTarget(triple, shasumsText);
  }
}

main().catch((err) => fail(`unhandled`, err));
