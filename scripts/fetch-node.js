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
 *   2. Env `TAURI_TARGET=<triple>`
 *   3. Host detection from `process.platform` + `process.arch`
 *
 * Idempotent: if the target binary already exists and its sibling `.sha256`
 * marker records the same nodeVersion + target + on-disk sha256, the download
 * is skipped.
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

// ---------------------------------------------------------------------------
// Pinned constants
// ---------------------------------------------------------------------------

const NODE_VERSION = "20.17.0";
const SHASUMS_URL = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`;
const DIST_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_DIR = path.resolve(__dirname, "../src-tauri/binaries");

/**
 * Map of supported Rust triples → fetch/extract descriptors.
 *
 * Fields:
 *   distBasename      — Node.js dist archive filename (for URL + SHASUMS lookup)
 *   archive           — "zip" | "tar.gz"
 *   innerBinaryPath   — path within the archive to the node binary
 *   outputFilename    — filename to write under src-tauri/binaries/
 *                       (Tauri externalBin convention: <base>-<triple>[.exe])
 */
const TARGETS = {
  "x86_64-pc-windows-msvc": {
    distBasename: `node-v${NODE_VERSION}-win-x64.zip`,
    archive: "zip",
    innerBinaryPath: `node-v${NODE_VERSION}-win-x64/node.exe`,
    outputFilename: "node-x86_64-pc-windows-msvc.exe",
  },
  "x86_64-apple-darwin": {
    distBasename: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    archive: "tar.gz",
    innerBinaryPath: `node-v${NODE_VERSION}-darwin-x64/bin/node`,
    outputFilename: "node-x86_64-apple-darwin",
  },
  "aarch64-apple-darwin": {
    distBasename: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    archive: "tar.gz",
    innerBinaryPath: `node-v${NODE_VERSION}-darwin-arm64/bin/node`,
    outputFilename: "node-aarch64-apple-darwin",
  },
  "x86_64-unknown-linux-gnu": {
    distBasename: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    archive: "tar.gz",
    innerBinaryPath: `node-v${NODE_VERSION}-linux-x64/bin/node`,
    outputFilename: "node-x86_64-unknown-linux-gnu",
  },
  "aarch64-unknown-linux-gnu": {
    distBasename: `node-v${NODE_VERSION}-linux-arm64.tar.gz`,
    archive: "tar.gz",
    innerBinaryPath: `node-v${NODE_VERSION}-linux-arm64/bin/node`,
    outputFilename: "node-aarch64-unknown-linux-gnu",
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Follow redirects and fetch a URL. Resolves with a Buffer for small payloads
 * (SHASUMS256.txt) or streams to a write stream for large payloads.
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
    req.setTimeout(120_000, () => {
      req.destroy(new Error(`Request to ${url} timed out after 120s`));
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
// Target selection
// ---------------------------------------------------------------------------

function detectHostTarget() {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (plat === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (plat === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (plat === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (plat === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  return null;
}

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
      `  2. TAURI_TARGET environment variable\n` +
      `  3. Host-detected target (process.platform + process.arch)\n\n` +
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
  const candidate =
    args.target ??
    process.env.TAURI_TARGET ??
    detectHostTarget();
  if (!candidate) {
    const supported = Object.keys(TARGETS).join(", ");
    fail(
      `could not auto-detect a supported target for ` +
        `platform=${process.platform} arch=${process.arch}. ` +
        `Pass --target=<triple> or set TAURI_TARGET. Supported: ${supported}`,
    );
  }
  if (!TARGETS[candidate]) {
    const supported = Object.keys(TARGETS).join(", ");
    fail(
      `unknown target '${candidate}'. Supported targets: ${supported}`,
    );
  }
  return [candidate];
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
    throw new Error(
      `zip does not contain expected entry ${innerPath}`,
    );
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
    throw new Error(
      `tar archive does not contain expected entry ${innerPath}`,
    );
  }
  const extracted = path.join(destDir, innerPath);
  if (!existsSync(extracted)) {
    throw new Error(
      `tar extraction reported match but ${extracted} is missing`,
    );
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

  // Look up the expected archive sha256 from the live SHASUMS.
  let expectedArchiveSha;
  try {
    expectedArchiveSha = findShasum(shasumsText, entry.distBasename);
  } catch (err) {
    fail(
      `[${triple}] could not locate sha256 for ${entry.distBasename}`,
      err,
    );
  }

  // Idempotency check.
  if (existsSync(outputPath) && existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (
        marker &&
        marker.nodeVersion === NODE_VERSION &&
        marker.target === triple &&
        typeof marker.sha256 === "string"
      ) {
        const actual = sha256File(outputPath);
        if (actual === marker.sha256) {
          log(
            `[${triple}] already present (v${NODE_VERSION}), skipping fetch`,
          );
          reportOutcome(triple, outputPath, false);
          return;
        }
        log(
          `[${triple}] existing binary sha256 mismatch (stored=${marker.sha256.slice(0, 12)}..., actual=${actual.slice(0, 12)}...) — re-fetching`,
        );
      } else if (marker && marker.target && marker.target !== triple) {
        log(
          `[${triple}] marker is for a different target (${marker.target}) — re-fetching`,
        );
      } else {
        log(
          `[${triple}] marker is for a different version/layout — re-fetching`,
        );
      }
    } catch (err) {
      log(
        `[${triple}] could not parse .sha256 marker (${err.message}) — re-fetching`,
      );
    }
  }

  // Download + extract in a scratch dir.
  const workDir = path.join(
    tmpdir(),
    `packetade-fetch-node-${triple}-${process.pid}-${Date.now()}`,
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
        `downloaded archive sha256 ${archiveSha} does not match ` +
          `SHASUMS256.txt (${expectedArchiveSha})`,
      );
    }
    log(`[${triple}] archive sha256 verified`);

    log(`[${triple}] extracting ${entry.innerBinaryPath}`);
    let binaryBuf;
    if (entry.archive === "zip") {
      binaryBuf = extractFromZip(archivePath, entry.innerBinaryPath);
    } else if (entry.archive === "tar.gz") {
      const extractedPath = await extractFromTarGz(
        archivePath,
        entry.innerBinaryPath,
        workDir,
      );
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

  // Fetch SHASUMS256.txt once and reuse across all targets.
  log(`fetching ${SHASUMS_URL}`);
  let shasumsBuf;
  try {
    shasumsBuf = await fetchBuffer(SHASUMS_URL);
  } catch (err) {
    fail(`failed to fetch SHASUMS256.txt`, err);
  }
  const shasumsText = shasumsBuf.toString("utf8");

  for (const triple of triples) {
    // Sequential — keeps network load friendly and logs readable.
    await processTarget(triple, shasumsText);
  }
}

main().catch((err) => fail(`unhandled`, err));
