import { describe, expect, it } from "vitest";
import {
  MCP_ROOT_LIMIT,
  mcpRootAddition,
  mcpRootCovers,
  mcpRootPlatformOf,
  mcpRootsEnforced,
  normalizeMcpRoot,
} from "../mcpRoots";

function expectRejected(raw: string, platform: "windows" | "posix" | "unknown" = "windows") {
  const result = normalizeMcpRoot(raw, platform);
  expect(result.ok, `expected ${JSON.stringify(raw)} to be refused`).toBe(false);
  return result.ok ? "" : result.error;
}

function expectAccepted(raw: string, platform: "windows" | "posix" | "unknown" = "windows") {
  const result = normalizeMcpRoot(raw, platform);
  expect(result.ok, `expected ${JSON.stringify(raw)} to be accepted`).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("normalizeMcpRoot — values that must never be stored", () => {
  // These four reduce to an empty path under the Rust runtime's
  // `normalize_lexical`, and `Path::starts_with("")` is true for every path on
  // the machine. Storing one would turn a per-server root allowlist into a
  // whole-filesystem grant that reads like a restriction.
  it.each(["", "   ", ".", "./", ".\\"])(
    "refuses %j, which the in-process runtime reads as every path on disk",
    (raw) => {
      expect(normalizeMcpRoot(raw, "windows").ok).toBe(false);
    },
  );

  it("refuses a `..` segment anywhere in the value", () => {
    expect(expectRejected("C:\\projects\\..\\Windows")).toMatch(/resolves it lexically/i);
    expect(expectRejected("/home/you/../../etc", "posix")).toMatch(/resolves it lexically/i);
  });

  it("refuses relative roots, which the two engines resolve differently", () => {
    expect(expectRejected("projects\\app")).toMatch(/absolute/i);
    expect(expectRejected("app", "posix")).toMatch(/absolute/i);
  });

  it("refuses a drive-relative root", () => {
    expect(expectRejected("C:projects")).toMatch(/drive-relative/i);
  });

  it("refuses verbatim and device prefixes that compare equal to nothing", () => {
    expect(expectRejected("\\\\?\\C:\\projects\\app")).toMatch(/verbatim/i);
    expect(expectRejected("\\\\.\\C:\\projects")).toMatch(/device/i);
  });

  it("refuses values neither engine expands", () => {
    expect(expectRejected("~")).toMatch(/not expanded/i);
    expect(expectRejected("~/projects", "posix")).toMatch(/not expanded/i);
    expect(expectRejected("%USERPROFILE%\\projects")).toMatch(/environment variables/i);
    expect(expectRejected("$HOME/projects", "posix")).toMatch(/environment variables/i);
  });

  it("refuses wildcards, which are compared literally and match nothing", () => {
    expect(expectRejected("C:\\projects\\*")).toMatch(/wildcard/i);
    expect(expectRejected("C:\\projects\\app?")).toMatch(/wildcard/i);
  });

  it("refuses URLs, including the file: form the sidecar accepts on candidates", () => {
    expect(expectRejected("file:///C:/projects/app")).toMatch(/filesystem path, not a URL/i);
    expect(expectRejected("https://example.com/repo")).toMatch(/filesystem path, not a URL/i);
  });

  it("refuses segments whose literal text cannot match a real directory", () => {
    // Trailing whitespace on the whole value is a paste artefact and is
    // trimmed; whitespace around an interior segment is not recoverable.
    expect(expectAccepted("C:\\projects\\app ").value).toBe("C:\\projects\\app");
    expect(expectRejected("C:\\projects\\app \\src")).toMatch(/whitespace/i);
    expect(expectRejected("C:\\projects\\app.")).toMatch(/trailing dot|ends with a dot/i);
    expect(expectRejected("C:\\projects\\a|b")).toMatch(/does not allow/i);
  });

  it("refuses a UNC value that names no share", () => {
    expect(expectRejected("\\\\fileserver")).toMatch(/server and the share/i);
  });

  it("refuses a control character and an absurdly long value", () => {
    expect(expectRejected("C:\\projects\\a\u0000b")).toMatch(/control character/i);
    expect(expectRejected(`C:\\${"a".repeat(5000)}`)).toMatch(/too long/i);
  });

  it("refuses a root shaped for the other platform", () => {
    expect(expectRejected("/home/you/app", "windows")).toMatch(/Windows paths/i);
    expect(expectRejected("C:\\projects\\app", "posix")).toMatch(/POSIX paths/i);
  });
});

describe("normalizeMcpRoot — accepted values and their normalisation", () => {
  it("normalises separators, trailing slashes and the drive letter, and says so", () => {
    const result = expectAccepted(" c:/projects//app/ ");
    expect(result.value).toBe("C:\\projects\\app");
    expect(result.notes.join(" ")).toMatch(/Upper-cased the drive letter/);
    expect(result.notes.join(" ")).toMatch(/Normalised separators/);
    expect(result.notes.join(" ")).toMatch(/Trimmed surrounding whitespace/);
  });

  it("strips a matched pair of quotes from a pasted path", () => {
    const result = expectAccepted('"C:\\projects\\app"');
    expect(result.value).toBe("C:\\projects\\app");
    expect(result.notes.join(" ")).toMatch(/Removed the surrounding quotes/);
  });

  it("always warns that segment case is compared case-sensitively", () => {
    expect(expectAccepted("C:\\Projects\\App").notes.join(" ")).toMatch(/case-sensitively/i);
  });

  it("accepts a UNC share path", () => {
    expect(expectAccepted("//fileserver/team/app").value).toBe("\\\\fileserver\\team\\app");
  });

  it("accepts POSIX paths and collapses their separators", () => {
    expect(expectAccepted("/home/you//app/", "posix").value).toBe("/home/you/app");
  });

  it("warns rather than refuses when a root is very broad", () => {
    expect(expectAccepted("C:\\").warnings.join(" ")).toMatch(/entire C: drive/);
    expect(expectAccepted("\\\\fileserver\\team").warnings.join(" ")).toMatch(/entire .* share/);
    expect(expectAccepted("/", "posix").warnings.join(" ")).toMatch(/entire filesystem/);
    expect(expectAccepted("C:\\Users\\you").warnings.join(" ")).toMatch(/credential stores/);
    expect(expectAccepted("/home/you", "posix").warnings.join(" ")).toMatch(/credential stores/);
  });
});

describe("root list bookkeeping", () => {
  it("detects duplicates case-insensitively, matching the looser engine", () => {
    expect(mcpRootAddition("C:\\Projects\\App", ["C:\\projects\\app"])).toEqual({
      status: "duplicate",
      existing: "C:\\projects\\app",
    });
  });

  it("reports a nested root as already covered", () => {
    expect(mcpRootAddition("C:\\projects\\app\\src", ["C:\\projects\\app"])).toEqual({
      status: "covered",
      existing: "C:\\projects\\app",
    });
  });

  it("does not treat a name-prefix sibling as covered", () => {
    expect(mcpRootCovers("C:\\projects\\app", "C:\\projects\\app-evil")).toBe(false);
    expect(mcpRootAddition("C:\\projects\\app-evil", ["C:\\projects\\app"])).toEqual({
      status: "add",
    });
  });

  it("stops at the root limit", () => {
    const full = Array.from({ length: MCP_ROOT_LIMIT }, (_, index) => `C:\\r${index}`);
    expect(mcpRootAddition("C:\\other", full)).toEqual({ status: "full" });
  });

  it("reads the platform dialect off the workspace path", () => {
    expect(mcpRootPlatformOf("D:\\projects\\demo")).toBe("windows");
    expect(mcpRootPlatformOf("\\\\srv\\share\\demo")).toBe("windows");
    expect(mcpRootPlatformOf("/home/you/demo")).toBe("posix");
    expect(mcpRootPlatformOf(null)).toBe("unknown");
  });

  it("reports roots as inert without the outside-workspace denial floor", () => {
    expect(mcpRootsEnforced(["credentials", "outside_workspace"])).toBe(true);
    expect(mcpRootsEnforced(["credentials", "protected_publish"])).toBe(false);
  });
});
