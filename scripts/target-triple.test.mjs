/**
 * Unit tests for scripts/target-triple.js — pure, no fs/network/process
 * mutation. Runs under the root vitest config (`pnpm test -- --run`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  SUPPORTED_TRIPLES,
  detectHostTarget,
  resolveTarget,
  tripleToSupportedArchitectures,
  sidecarPlatformPackage,
} from "./target-triple.js";

describe("SUPPORTED_TRIPLES", () => {
  it("contains exactly the five supported triples", () => {
    expect([...SUPPORTED_TRIPLES].sort()).toEqual(
      [
        "x86_64-pc-windows-msvc",
        "x86_64-apple-darwin",
        "aarch64-apple-darwin",
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
      ].sort(),
    );
  });
});

describe("tripleToSupportedArchitectures", () => {
  it("maps x86_64-pc-windows-msvc to win32/x64 with no libc", () => {
    expect(tripleToSupportedArchitectures("x86_64-pc-windows-msvc")).toEqual({
      os: ["win32"],
      cpu: ["x64"],
    });
  });

  it("maps x86_64-apple-darwin to darwin/x64 with no libc", () => {
    expect(tripleToSupportedArchitectures("x86_64-apple-darwin")).toEqual({
      os: ["darwin"],
      cpu: ["x64"],
    });
  });

  it("maps aarch64-apple-darwin to darwin/arm64 with no libc", () => {
    expect(tripleToSupportedArchitectures("aarch64-apple-darwin")).toEqual({
      os: ["darwin"],
      cpu: ["arm64"],
    });
  });

  it("maps x86_64-unknown-linux-gnu to linux/x64 with glibc", () => {
    expect(tripleToSupportedArchitectures("x86_64-unknown-linux-gnu")).toEqual({
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    });
  });

  it("maps aarch64-unknown-linux-gnu to linux/arm64 with glibc", () => {
    expect(tripleToSupportedArchitectures("aarch64-unknown-linux-gnu")).toEqual({
      os: ["linux"],
      cpu: ["arm64"],
      libc: ["glibc"],
    });
  });

  it("throws on an unknown triple", () => {
    expect(() => tripleToSupportedArchitectures("x86_64-unknown-linux-musl")).toThrow(
      /unknown target/,
    );
  });
});

describe("sidecarPlatformPackage", () => {
  it("maps aarch64-apple-darwin to the darwin-arm64 package", () => {
    expect(sidecarPlatformPackage("aarch64-apple-darwin")).toBe(
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    );
  });

  it("maps x86_64-pc-windows-msvc to the win32-x64 package", () => {
    expect(sidecarPlatformPackage("x86_64-pc-windows-msvc")).toBe(
      "@anthropic-ai/claude-agent-sdk-win32-x64",
    );
  });

  it("maps x86_64-unknown-linux-gnu to the linux-x64 package", () => {
    expect(sidecarPlatformPackage("x86_64-unknown-linux-gnu")).toBe(
      "@anthropic-ai/claude-agent-sdk-linux-x64",
    );
  });

  it("maps the remaining triples", () => {
    expect(sidecarPlatformPackage("x86_64-apple-darwin")).toBe(
      "@anthropic-ai/claude-agent-sdk-darwin-x64",
    );
    expect(sidecarPlatformPackage("aarch64-unknown-linux-gnu")).toBe(
      "@anthropic-ai/claude-agent-sdk-linux-arm64",
    );
  });

  it("throws on an unknown triple", () => {
    expect(() => sidecarPlatformPackage("wasm32-unknown-unknown")).toThrow(/unknown target/);
  });
});

describe("detectHostTarget", () => {
  it("maps known platform/arch pairs", () => {
    expect(detectHostTarget("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(detectHostTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(detectHostTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(detectHostTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(detectHostTarget("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
  });

  it("returns null for unsupported combos", () => {
    expect(detectHostTarget("freebsd", "x64")).toBeNull();
    expect(detectHostTarget("win32", "arm64")).toBeNull();
    expect(detectHostTarget("linux", "riscv64")).toBeNull();
  });
});

describe("resolveTarget", () => {
  it("prefers --target= over both env vars", () => {
    expect(
      resolveTarget({
        argv: ["node", "script.js", "--target=aarch64-apple-darwin"],
        env: {
          TAURI_TARGET: "x86_64-pc-windows-msvc",
          TAURI_ENV_TARGET_TRIPLE: "x86_64-unknown-linux-gnu",
        },
      }),
    ).toBe("aarch64-apple-darwin");
  });

  it("throws when TAURI_TARGET disagrees with the Tauri-injected triple", () => {
    // A stale `export TAURI_TARGET=...` used to silently outrank the triple
    // Tauri actually compiles for, redirecting fetch-node, prune-sidecar, and
    // release-gate to the same wrong target — so they all agreed with each
    // other and the gate could not see the mismatch. Refuse to guess.
    expect(() =>
      resolveTarget({
        argv: ["node", "script.js"],
        env: {
          TAURI_TARGET: "x86_64-pc-windows-msvc",
          TAURI_ENV_TARGET_TRIPLE: "x86_64-unknown-linux-gnu",
        },
      }),
    ).toThrow(/conflicting target triples/);
  });

  it("accepts agreeing env vars", () => {
    expect(
      resolveTarget({
        argv: ["node", "script.js"],
        env: {
          TAURI_TARGET: "x86_64-unknown-linux-gnu",
          TAURI_ENV_TARGET_TRIPLE: "x86_64-unknown-linux-gnu",
        },
      }),
    ).toBe("x86_64-unknown-linux-gnu");
  });

  it("prefers the Tauri-injected TAURI_ENV_TARGET_TRIPLE", () => {
    expect(
      resolveTarget({
        argv: ["node", "script.js"],
        env: { TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" },
      }),
    ).toBe("x86_64-apple-darwin");
  });

  it("falls back to TAURI_TARGET when Tauri injects nothing", () => {
    expect(
      resolveTarget({
        argv: ["node", "script.js"],
        env: { TAURI_TARGET: "x86_64-pc-windows-msvc" },
      }),
    ).toBe("x86_64-pc-windows-msvc");
  });

  it("throws on an unknown --target= triple", () => {
    expect(() =>
      resolveTarget({ argv: ["node", "script.js", "--target=mips64-unknown-linux-gnu"], env: {} }),
    ).toThrow(/unknown target/);
  });

  it("throws on an unknown env triple", () => {
    expect(() => resolveTarget({ argv: [], env: { TAURI_TARGET: "not-a-triple" } })).toThrow(
      /unknown target/,
    );
    expect(() =>
      resolveTarget({ argv: [], env: { TAURI_ENV_TARGET_TRIPLE: "not-a-triple" } }),
    ).toThrow(/unknown target/);
  });

  it("ignores empty env values", () => {
    expect(
      resolveTarget({
        argv: [],
        env: { TAURI_TARGET: "", TAURI_ENV_TARGET_TRIPLE: "aarch64-unknown-linux-gnu" },
      }),
    ).toBe("aarch64-unknown-linux-gnu");
  });

  it("host-detect fallback returns a supported triple or throws", () => {
    let resolved;
    try {
      resolved = resolveTarget({ argv: [], env: {} });
    } catch (err) {
      expect(String(err)).toMatch(/could not auto-detect/);
      return;
    }
    expect(SUPPORTED_TRIPLES).toContain(resolved);
  });
});

describe("release gate target artifacts", () => {
  it("does not retain a host-specific Windows Node prerequisite", () => {
    const source = readFileSync("scripts/release-gate.mjs", "utf8");
    expect(source).not.toContain("node-x86_64-pc-windows-msvc.exe");
    // The staged-runtime path is derived from the resolved target rather than
    // spelled out, via the shared descriptor in scripts/node-runtime.js.
    expect(source).toContain("nodeBinaryRelPath(triple)");
    expect(source).toContain("verifyStagedNodeRuntime(releaseTarget)");
  });

  it("verifies the staged Node runtime's digest rather than its existence", () => {
    const source = readFileSync("scripts/release-gate.mjs", "utf8");
    expect(source).toContain("nodeArchiveSha256(triple)");
    expect(source).toContain('createHash("sha256")');
  });

  it("does not accept the updater signing key as code-signing evidence", () => {
    // TAURI_SIGNING_PRIVATE_KEY is the minisign key for the updater manifest.
    // It must never appear in the Authenticode / Apple Developer ID credential
    // lists — that false PASS is what --require-signing exists to prevent.
    const source = readFileSync("scripts/release-gate.mjs", "utf8");
    const authenticodeList = source.match(/const authenticodeEnv = \[([\s\S]*?)\]/)?.[1];
    const appleList = source.match(/const appleEnv = \[([\s\S]*?)\]/)?.[1];
    expect(authenticodeList).toBeTruthy();
    expect(appleList).toBeTruthy();
    expect(authenticodeList).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(appleList).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
  });
});
