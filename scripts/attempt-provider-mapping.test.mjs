/**
 * One mapping from agent-config id to backend provider id — not two.
 *
 * `AttemptTargetSpec.provider` is forwarded verbatim by
 * `src-tauri/src/commands/flight_attempts.rs` into `start_api_agent_session`,
 * which routes it to the sidecar or to the Rust `get_provider` dispatch.
 * Neither side knows agent-config ids. Deriving the provider with
 * `agentConfigId.replace(/^api-/, "")` looks right for seven of the eight
 * executors and is wrong for the DEFAULT one (`api-claude` -> `"claude"`,
 * which `get_provider` rejects) — a shape that survives review easily, which
 * is exactly why it needs a source-level fence rather than only a unit test.
 *
 * Every attempt/session spec must resolve its provider through
 * `attemptProviderFor` in `src/lib/attemptRouting.ts`.
 *
 * Lives in `scripts/` for the same reason `confirm-idiom.test.mjs` does: it
 * needs `node:fs`, which the app tsconfig does not carry.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();

/** Files allowed to mention the banned pattern, and why. */
const ALLOWED = new Set([
  // The fence's own unit-test counterpart demonstrates the broken derivation
  // in order to assert the shared helper diverges from it.
  "src/lib/__tests__/attemptRouting.test.ts",
]);

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if ([".ts", ".tsx"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

/**
 * A live `api-` prefix strip: `.replace(/^api-/, "")`,
 * `.slice("api-".length)`, `.substring(4)` off an `api-` literal, or the Rust-
 * style `trimStart`. Kept deliberately narrow — it must fire on the real
 * derivation and stay silent on the many legitimate `startsWith("api-")`
 * checks (`isApiAgent`, badge rendering), which classify rather than derive.
 */
const PREFIX_STRIP = /(?:replace(?:All)?\s*\(\s*\/\^api-\/|slice\s*\(\s*["'`]api-["'`]\.length)/;

/** Blank out comments so prose describing the banned pattern doesn't trip it. */
function stripComments(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*/, ""))
    .join("\n");
}

export function stripsApiPrefix(body) {
  return PREFIX_STRIP.test(stripComments(body));
}

describe("attempt provider-id derivation", () => {
  it("no source file derives a provider id by stripping the api- prefix", () => {
    const offenders = sourceFiles(join(ROOT, "src"))
      .map((file) => [relative(ROOT, file).replaceAll("\\", "/"), file])
      .filter(([rel]) => !ALLOWED.has(rel))
      .filter(([, file]) => stripsApiPrefix(readFileSync(file, "utf8")))
      .map(([rel]) => rel);

    expect(offenders).toEqual([]);
  });

  it.each([
    ["regex replace", 'const provider = agent.replace(/^api-/, "");'],
    ["regex replaceAll", 'const provider = agent.replaceAll(/^api-/g, "");'],
    ["spaced regex replace", "const p = agent.replace( /^api-/ , '' );'"],
    ["slice by literal length", 'const provider = agent.slice("api-".length);'],
  ])("catches a real prefix-strip: %s", (_name, source) => {
    expect(stripsApiPrefix(source)).toBe(true);
  });

  it.each([
    ["classification, not derivation", 'const isApi = agent.startsWith("api-");'],
    ["line comment describing the ban", '// never do agent.replace(/^api-/, "")'],
    ["block comment describing the ban", '/* was: agent.replace(/^api-/, "") */'],
    ["an unrelated replace", 'const label = agent.replace(/^cli-/, "");'],
    ["the shared helper being used", "const provider = attemptProviderFor(p.agent);"],
  ])("ignores a false positive: %s", (_name, source) => {
    expect(stripsApiPrefix(source)).toBe(false);
  });

  it("the shared helper exists and every attempt-spec builder imports it", () => {
    const helper = "src/lib/attemptRouting.ts";
    expect(readFileSync(join(ROOT, helper), "utf8")).toContain(
      "export function attemptProviderFor",
    );

    // Every file that builds an AttemptTargetSpec. A silent revert to an
    // inline derivation drops the import and shows up here.
    for (const expected of [
      // The manual launch path (LaunchAsyncFlightModal's picked targets).
      "src/components/flights/pickedToSpec.ts",
      // Reassign-after-failure + cooperative task launches.
      "src/stores/asyncFlightStore.ts",
    ]) {
      expect(readFileSync(join(ROOT, expected), "utf8")).toContain("attemptProviderFor");
    }
  });
});
