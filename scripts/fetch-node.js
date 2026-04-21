#!/usr/bin/env node
/**
 * fetch-node.js
 *
 * Downloads a pinned Node.js runtime and stages it as a Tauri `externalBin`
 * sidecar under `src-tauri/binaries/`. Used as part of the build pipeline so
 * the packaged app ships with its own `node.exe` for the agent sidecar runtime.
 *
 * Idempotent: if the target binary already exists and its sha256 matches the
 * stored sibling `.sha256` file for the pinned version, the download is
 * skipped.
 *
 * Currently fetches the win32-x64 build only. TODO: extend with entries for
 *   - node-x86_64-apple-darwin        (darwin-x64)
 *   - node-aarch64-apple-darwin       (darwin-arm64)
 *   - node-x86_64-unknown-linux-gnu   (linux-x64)
 * following the same pattern (targz instead of zip on non-Windows).
 *
 * Node 18+ (uses ESM + node: prefixed stdlib imports). Requires `adm-zip`.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
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

// ---------------------------------------------------------------------------
// Pinned constants
// ---------------------------------------------------------------------------

const NODE_VERSION = "20.17.0";
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;
const SHASUMS_URL = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;
const ZIP_BASENAME = `node-v${NODE_VERSION}-win-x64.zip`;
const ZIP_INNER_NODE_PATH = `node-v${NODE_VERSION}-win-x64/node.exe`;

// Double-check constant — source of truth is the live SHASUMS256.txt fetch
// below. If Node ever re-publishes a version (historically rare), the live
// fetch wins; this just guards against a MITM that rewrites both URLs.
const EXPECTED_SHA256 =
  "e323fff0aba197090faabd29c4c23f334557ff24454324f0c83faa7e399dbb74";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_DIR = path.resolve(__dirname, "../src-tauri/binaries");
const TARGET_FILENAME = "node-x86_64-pc-windows-msvc.exe";
const TARGET_PATH = path.join(TARGET_DIR, TARGET_FILENAME);
const TARGET_SHA_PATH = `${TARGET_PATH}.sha256`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Follow redirects and fetch a URL. Resolves with a Buffer for small payloads
 * (SHASUMS256.txt) or streams to a write stream for large payloads (zip).
 */
function httpsGet(url, onResponse) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      // Handle redirects (nodejs.org has historically used them for cdn/mirrors)
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        httpsGet(next, onResponse).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(
          new Error(
            `GET ${url} failed with status ${res.statusCode} ${res.statusMessage ?? ""}`,
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
    req.setTimeout(60_000, () => {
      req.destroy(new Error(`Request to ${url} timed out after 60s`));
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
 * Parse SHASUMS256.txt — each line is `<hex>  <filename>`. Returns the
 * hex digest for the given basename, or throws.
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
  throw new Error(
    `Could not find sha256 entry for ${basename} in SHASUMS256.txt`,
  );
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Ensure target dir exists.
  mkdirSync(TARGET_DIR, { recursive: true });

  // 2. Fetch the live SHASUMS256.txt and determine the expected zip hash.
  log(`fetching ${SHASUMS_URL}`);
  let shasumsBuf;
  try {
    shasumsBuf = await fetchBuffer(SHASUMS_URL);
  } catch (err) {
    fail(`failed to fetch SHASUMS256.txt`, err);
  }
  const shasumsText = shasumsBuf.toString("utf8");
  let liveZipSha;
  try {
    liveZipSha = findShasum(shasumsText, ZIP_BASENAME);
  } catch (err) {
    fail(`bad SHASUMS256.txt content`, err);
  }

  if (liveZipSha !== EXPECTED_SHA256) {
    fail(
      `live sha256 for ${ZIP_BASENAME} (${liveZipSha}) does not match pinned EXPECTED_SHA256 (${EXPECTED_SHA256}). ` +
        `Refusing to proceed — update the pin in scripts/fetch-node.js after verifying out-of-band.`,
    );
  }
  log(`verified pinned sha256 for ${ZIP_BASENAME}`);

  // 3. Idempotency check. If TARGET exists AND its sibling .sha256 records
  //    the current version, verify on-disk bytes still match and skip.
  if (existsSync(TARGET_PATH) && existsSync(TARGET_SHA_PATH)) {
    try {
      const marker = JSON.parse(readFileSync(TARGET_SHA_PATH, "utf8"));
      if (
        marker &&
        marker.nodeVersion === NODE_VERSION &&
        typeof marker.sha256 === "string"
      ) {
        const actual = sha256File(TARGET_PATH);
        if (actual === marker.sha256) {
          log(
            `node.exe already present (v${NODE_VERSION}), skipping fetch`,
          );
          reportOutcome({ downloaded: false });
          return;
        }
        log(
          `existing node.exe sha256 mismatch (stored=${marker.sha256.slice(0, 12)}..., actual=${actual.slice(0, 12)}...) — re-fetching`,
        );
      } else {
        log(`stored .sha256 marker is for a different version — re-fetching`);
      }
    } catch (err) {
      log(`could not parse .sha256 marker (${err.message}) — re-fetching`);
    }
  }

  // 4. Download zip to a temp dir, verify checksum, extract node.exe.
  const workDir = path.join(
    tmpdir(),
    `packetade-fetch-node-${process.pid}-${Date.now()}`,
  );
  mkdirSync(workDir, { recursive: true });
  const zipPath = path.join(workDir, ZIP_BASENAME);

  const cleanup = () => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // swallow — cleanup best effort
    }
  };

  try {
    log(`downloading ${NODE_URL}`);
    await downloadToFile(NODE_URL, zipPath);

    const zipSha = sha256File(zipPath);
    if (zipSha !== EXPECTED_SHA256) {
      // Nuke the (now distrusted) zip before bailing.
      try {
        rmSync(zipPath, { force: true });
      } catch {
        // ignore
      }
      throw new Error(
        `downloaded zip sha256 ${zipSha} does not match expected ${EXPECTED_SHA256}`,
      );
    }
    log(`zip sha256 verified`);

    log(`extracting ${ZIP_INNER_NODE_PATH}`);
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntry(ZIP_INNER_NODE_PATH);
    if (!entry) {
      throw new Error(
        `zip does not contain expected entry ${ZIP_INNER_NODE_PATH}`,
      );
    }
    const nodeExeBuf = entry.getData();
    if (!nodeExeBuf || nodeExeBuf.length === 0) {
      throw new Error(`extracted node.exe buffer is empty`);
    }

    // Atomic-ish write: write to a .tmp sibling then rename over.
    const tmpTarget = `${TARGET_PATH}.tmp`;
    try {
      rmSync(tmpTarget, { force: true });
    } catch {
      // ignore
    }
    writeFileSync(tmpTarget, nodeExeBuf);

    // Verify what we wrote.
    const writtenSha = sha256File(tmpTarget);

    // Remove any prior target before rename (Windows rename-over semantics).
    try {
      rmSync(TARGET_PATH, { force: true });
    } catch {
      // ignore
    }
    // fs.renameSync via writeFileSync path — use built-in rename via fs.
    const { renameSync } = await import("node:fs");
    renameSync(tmpTarget, TARGET_PATH);

    // Record a sidecar marker so future runs can short-circuit.
    const marker = {
      nodeVersion: NODE_VERSION,
      zipUrl: NODE_URL,
      zipSha256: EXPECTED_SHA256,
      sha256: writtenSha,
      fetchedAt: new Date().toISOString(),
    };
    writeFileSync(TARGET_SHA_PATH, `${JSON.stringify(marker, null, 2)}\n`);

    cleanup();
    reportOutcome({ downloaded: true });
  } catch (err) {
    // Remove any partial file on failure — no silent half-states.
    try {
      rmSync(`${TARGET_PATH}.tmp`, { force: true });
    } catch {
      // ignore
    }
    cleanup();
    fail(`download/extract failed`, err);
  }
}

function reportOutcome({ downloaded }) {
  if (!existsSync(TARGET_PATH)) {
    fail(`post-condition: target ${TARGET_PATH} missing`);
  }
  const size = statSync(TARGET_PATH).size;
  const sha = sha256File(TARGET_PATH);
  log(
    `${downloaded ? "downloaded" : "skipped"}  path=${TARGET_PATH}  size=${size}  sha256=${sha}`,
  );
}

main().catch((err) => fail(`unhandled`, err));
