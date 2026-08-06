#!/usr/bin/env node
/**
 * target-triple.js
 *
 * Single source of truth for the Rust target triples the build pipeline
 * supports, plus pure helpers to resolve which triple a build is for and
 * to map a triple onto pnpm / sidecar platform metadata.
 *
 * Consumers:
 *   - scripts/fetch-node.js    — which Node runtime to download
 *   - scripts/prune-sidecar.js — which platform-specific sidecar deps to
 *                                materialise (pnpm `supportedArchitectures`)
 *   - scripts/release-gate.mjs — cross-checks that the staged Node runtime
 *                                and the installed sidecar platform package
 *                                agree on the same target
 *
 * Pure module: no fs, no network, no process mutation. `resolveTarget`
 * reads `process.platform`/`process.arch` only as a last-resort fallback
 * (and via the injectable `detectHostTarget` default parameters).
 *
 * Node 18+ (ESM).
 */

/** The five Rust target triples the build pipeline supports. */
export const SUPPORTED_TRIPLES = Object.freeze([
  "x86_64-pc-windows-msvc",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
]);

/**
 * Per-triple platform metadata in Node/pnpm vocabulary.
 * `libc` is only meaningful on linux (all supported linux triples are gnu).
 */
const TRIPLE_INFO = Object.freeze({
  "x86_64-pc-windows-msvc": { os: "win32", cpu: "x64" },
  "x86_64-apple-darwin": { os: "darwin", cpu: "x64" },
  "aarch64-apple-darwin": { os: "darwin", cpu: "arm64" },
  "x86_64-unknown-linux-gnu": { os: "linux", cpu: "x64", libc: "glibc" },
  "aarch64-unknown-linux-gnu": { os: "linux", cpu: "arm64", libc: "glibc" },
});

function assertSupported(triple, source) {
  if (typeof triple !== "string" || !Object.prototype.hasOwnProperty.call(TRIPLE_INFO, triple)) {
    throw new Error(
      `unknown target '${triple}'${source ? ` (from ${source})` : ""}. ` +
        `Supported targets: ${SUPPORTED_TRIPLES.join(", ")}`,
    );
  }
  return triple;
}

/**
 * Detect the host's target triple from Node's platform/arch strings.
 * Returns `null` when the host is not one of the supported triples.
 */
export function detectHostTarget(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  return null;
}

/**
 * Resolve the build's target triple.
 *
 * Priority (mirrors fetch-node.js's documented contract):
 *   1. CLI `--target=<triple>` anywhere in `argv`
 *   2. Env `TAURI_ENV_TARGET_TRIPLE` (injected by Tauri for beforeBuildCommand)
 *   3. Env `TAURI_TARGET` (manual override for standalone script runs)
 *   4. Host detection (process.platform + process.arch)
 *
 * `TAURI_ENV_TARGET_TRIPLE` outranks `TAURI_TARGET` because it is what the
 * build actually compiles for. When both are set and disagree this throws
 * rather than picking one: a stale `TAURI_TARGET` export in the shell would
 * otherwise silently redirect fetch-node, prune-sidecar, and release-gate to
 * the same wrong triple, so every consumer would agree with itself and the
 * gate could not detect that the bundle ships the wrong native binaries.
 *
 * Throws on an unknown/unsupported triple from any source, and when the
 * host cannot be detected as a supported triple.
 */
export function resolveTarget({ argv = process.argv, env = process.env } = {}) {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("--target=")) {
      return assertSupported(arg.slice("--target=".length), "--target=");
    }
  }
  const injected = env.TAURI_ENV_TARGET_TRIPLE?.trim();
  const override = env.TAURI_TARGET?.trim();
  if (injected && override) {
    assertSupported(injected, "TAURI_ENV_TARGET_TRIPLE env");
    assertSupported(override, "TAURI_TARGET env");
    if (injected !== override) {
      throw new Error(
        `conflicting target triples: TAURI_ENV_TARGET_TRIPLE='${injected}' ` +
          `(injected by Tauri) but TAURI_TARGET='${override}'. Unset the stale ` +
          `TAURI_TARGET export, or pass --target=<triple> to state the intent ` +
          `explicitly.`,
      );
    }
  }
  if (injected) {
    return assertSupported(injected, "TAURI_ENV_TARGET_TRIPLE env");
  }
  if (override) {
    return assertSupported(override, "TAURI_TARGET env");
  }
  const host = detectHostTarget();
  if (!host) {
    throw new Error(
      `could not auto-detect a supported target for ` +
        `platform=${process.platform} arch=${process.arch}. ` +
        `Pass --target=<triple> or set TAURI_TARGET. ` +
        `Supported targets: ${SUPPORTED_TRIPLES.join(", ")}`,
    );
  }
  return host;
}

/**
 * Map a triple onto pnpm's `pnpm.supportedArchitectures` package.json
 * field shape ({ os: string[], cpu: string[], libc?: string[] }), used to
 * force cross-arch optional-dependency resolution during the prod prune.
 */
export function tripleToSupportedArchitectures(triple) {
  const info = TRIPLE_INFO[assertSupported(triple)];
  const out = { os: [info.os], cpu: [info.cpu] };
  if (info.libc) {
    out.libc = [info.libc];
  }
  return out;
}

/**
 * The `@anthropic-ai/claude-agent-sdk-<os>-<cpu>` platform package that
 * must be present in the pruned sidecar node_modules for `triple` (it
 * carries the native `claude` executable the bundled sidecar runs).
 */
export function sidecarPlatformPackage(triple) {
  const info = TRIPLE_INFO[assertSupported(triple)];
  return `@anthropic-ai/claude-agent-sdk-${info.os}-${info.cpu}`;
}
