/**
 * Validation and normalisation for MCP trust `allowedRoots`.
 *
 * WHY THIS FILE IS PARANOID
 * -------------------------
 * `allowedRoots` is a security control with TWO independent enforcement
 * engines that do NOT agree on what a root means:
 *
 *   1. Rust, in-process — `path_inside_root` in
 *      `src-tauri/src/core/mcp_bridge.rs`. Purely LEXICAL: `normalize_lexical`
 *      drops `.` and pops on `..` without touching the filesystem, then
 *      `Path::starts_with` compares COMPONENT-WISE. No symlink resolution, no
 *      canonicalisation. On Windows the drive-letter prefix compares
 *      case-INsensitively but every other segment compares case-SENSITIVELY.
 *
 *   2. Node, in the sidecar — `isInsideRoot` in
 *      `agent-sidecar/src/mcp-trust.ts`. Uses `path.resolve` + `path.relative`,
 *      which on Windows is case-INsensitive throughout, resolves a RELATIVE
 *      root against the sidecar process's working directory, and accepts
 *      `file:` URL candidates. Also no symlink resolution.
 *
 * Values that mean different things to those two engines are the whole
 * problem. The measured divergences (verified by running both implementations
 * against the same inputs) are:
 *
 *   | root                  | Rust                       | Node                     |
 *   |-----------------------|----------------------------|--------------------------|
 *   | `""`, `"."`, `"./"`   | matches EVERY path on disk | the sidecar's own cwd    |
 *   | `"repo"` (relative)   | matches nothing            | sidecar cwd + `repo`     |
 *   | `"C:"` (drive-rel.)   | the whole C: drive         | C:'s per-drive cwd       |
 *   | `"~"`, `"~/proj"`     | a literal directory `~`    | a literal `~` under cwd  |
 *   | `\\?\C:\repo`         | matches nothing            | matches nothing          |
 *   | segment case          | case-SENSITIVE             | case-INsensitive         |
 *
 * The first row is the dangerous one: a root of `.` or `""` is a UNIVERSAL
 * ALLOW under the Rust runtime. It reads like "no root configured" and it is
 * in fact "every file on the machine". Nothing may ever store such a value, so
 * this module refuses `.`/`..`/empty segments outright rather than trying to
 * resolve them.
 *
 * WHAT EMPTY MEANS
 * ----------------
 * An empty `allowedRoots` array is NOT "unrestricted". Both engines short
 * circuit on it in the deny direction:
 *
 *   Rust:  `snapshot.allowed_roots.is_empty() || !roots.any(...)`  -> denied
 *   Node:  `roots.length === 0 || !roots.some(...)`                -> denied
 *
 * so with zero roots every path-like tool argument is refused. That is the
 * strictest possible state, and removing the last root is therefore SAFE. The
 * UI still says so explicitly, because "empty means locked" is the opposite of
 * what most allowlists do.
 *
 * The real caveat is elsewhere: the roots check only runs at all when the
 * server's `denialFloors` contain `outside_workspace`. Without that floor the
 * roots are inert no matter what they contain. `mcpRootsEnforced` exposes that
 * so the UI can say it out loud.
 */

/** Result shape mirrors the git-host wizard's URL normaliser. */
export type McpRootNormalization =
  | { ok: true; value: string; notes: string[]; warnings: string[] }
  | { ok: false; error: string };

export type McpRootPlatform = "windows" | "posix" | "unknown";

/** Guardrail on list size, matching the bounded-autonomy policy's cap. */
export const MCP_ROOT_LIMIT = 50;
/** Well under any filesystem limit; a longer value is a paste accident. */
const MAX_ROOT_LENGTH = 4096;

/** Characters Windows forbids in a path segment. `:` is handled by the drive parser. */
const WINDOWS_FORBIDDEN_SEGMENT = /[<>:"|]/;
/** Written as a scan rather than a character class: a control-char regex is a lint error. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
/** Two or more leading chars before `:` is a URL scheme; one char is a drive. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;
const ENV_REFERENCE = /%[^%]+%|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;
const DRIVE_ABSOLUTE = /^([A-Za-z]):[\\/]/;
const DRIVE_RELATIVE = /^([A-Za-z]):(?![\\/])/;

/**
 * Guess which enforcement dialect a workspace speaks, so a POSIX-shaped root
 * typed into a Windows workspace is refused with an explanation rather than
 * stored as a value that silently matches nothing.
 */
export function mcpRootPlatformOf(workspacePath: string | null | undefined): McpRootPlatform {
  if (!workspacePath) return "unknown";
  if (DRIVE_ABSOLUTE.test(workspacePath) || workspacePath.startsWith("\\\\")) return "windows";
  if (workspacePath.startsWith("/")) return "posix";
  return "unknown";
}

function reject(error: string): McpRootNormalization {
  return { ok: false, error };
}

function stripMatchedQuotes(value: string, notes: string[]): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length > 1 && value.endsWith(first)) {
    notes.push("Removed the surrounding quotes.");
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Reject a segment that can never compare equal to a real directory name.
 * Returns an error string, or null when the segment is acceptable.
 */
function segmentProblem(segment: string, platform: McpRootPlatform): string | null {
  if (segment === "." || segment === "..") {
    return (
      `"${segment}" is not allowed in a root. The Rust runtime resolves it lexically — a root ` +
      `that reduces to "." matches every file on the machine — while the sidecar resolves it ` +
      `against its own working directory. Enter the fully expanded path instead.`
    );
  }
  if (segment.trim() !== segment) {
    return (
      `The segment "${segment}" starts or ends with whitespace. Enforcement compares path ` +
      `text literally, so this would never match the directory you mean.`
    );
  }
  if (segment.endsWith(".")) {
    return (
      `The segment "${segment}" ends with a dot. Windows strips trailing dots when creating a ` +
      `directory, so the stored root could never match the real path.`
    );
  }
  if (platform !== "posix" && WINDOWS_FORBIDDEN_SEGMENT.test(segment)) {
    return `The segment "${segment}" contains a character Windows does not allow in a path.`;
  }
  return null;
}

/**
 * Validate and normalise one root.
 *
 * Fails CLOSED: anything whose meaning differs between the two enforcement
 * engines, or that cannot be shown to name a single literal directory, is
 * refused with the reason rather than stored in a loosely-interpretable form.
 */
export function normalizeMcpRoot(raw: string, platform: McpRootPlatform = "unknown"): McpRootNormalization {
  const notes: string[] = [];
  const warnings: string[] = [];

  let value = raw.trim();
  if (value !== raw) notes.push("Trimmed surrounding whitespace.");
  value = stripMatchedQuotes(value, notes);

  if (!value) {
    return reject(
      "Enter a directory path. An empty value is stored by the Rust runtime as a root that " +
        "matches every file on the machine, so it is never accepted here.",
    );
  }
  if (value.length > MAX_ROOT_LENGTH) {
    return reject(`Too long (${value.length} characters). A root must be under ${MAX_ROOT_LENGTH}.`);
  }
  if (hasControlCharacter(value)) {
    return reject("Contains a control character. Paste the path as plain text.");
  }

  // Verbatim / device prefixes first: they also contain `?`, and the wildcard
  // message would be the wrong explanation.
  if (value.startsWith("\\\\?\\") || value.startsWith("//?/")) {
    return reject(
      "Win32 verbatim paths (\\\\?\\...) never compare equal to an ordinary path in either " +
        "enforcement engine, so a root spelled this way would match nothing. Use the plain form.",
    );
  }
  if (value.startsWith("\\\\.\\") || value.startsWith("//./")) {
    return reject("Win32 device paths (\\\\.\\...) do not name a directory tree.");
  }
  if (value.includes("*") || value.includes("?")) {
    return reject(
      "Wildcards are not supported. Enforcement compares literal path components, so a pattern " +
        "would never match. Add each directory separately.",
    );
  }
  if (ENV_REFERENCE.test(value)) {
    return reject(
      "Environment variables are not expanded by either enforcement engine. Enter the expanded path.",
    );
  }
  if (value.startsWith("~")) {
    return reject(
      "~ is not expanded by either enforcement engine — it would be stored as a literal directory " +
        "named '~'. Enter the expanded home path.",
    );
  }
  if (URL_SCHEME.test(value)) {
    return reject(
      "Enter a filesystem path, not a URL. A root is compared against path text; the Rust runtime " +
        "never converts a URL and would refuse every candidate.",
    );
  }

  const isUnc = value.startsWith("\\\\") || value.startsWith("//");
  const driveAbsolute = DRIVE_ABSOLUTE.exec(value);
  const driveRelative = DRIVE_RELATIVE.exec(value);
  const posixAbsolute = !isUnc && value.startsWith("/");

  if (driveRelative) {
    return reject(
      `"${value}" is drive-relative. The Rust runtime reads it as the whole ${driveRelative[1].toUpperCase()}: ` +
        `drive while the sidecar resolves it against that drive's current directory. Write it as ` +
        `${driveRelative[1].toUpperCase()}:\\... instead.`,
    );
  }

  if (!driveAbsolute && !isUnc && !posixAbsolute) {
    // The universal-allow case gets its own explanation rather than the
    // generic one: a value made only of `.`/`..` segments reduces to an empty
    // path under the Rust runtime, and every candidate path starts with the
    // empty path. It reads like "the current directory" and means "everything".
    const degenerate = value
      .split(/[\\/]/)
      .every((segment) => segment === "" || segment === "." || segment === "..");
    if (degenerate) {
      return reject(
        `"${value}" reduces to no path at all. The Rust runtime resolves it lexically, so such a ` +
          `root matches every file on the machine, while the sidecar resolves it against its own ` +
          `working directory. Enter the fully expanded path instead.`,
      );
    }
    return reject(
      "A root must be an absolute path. A relative root matches nothing under the Rust runtime and " +
        "resolves against the sidecar's own working directory under the Node runtime.",
    );
  }

  if (posixAbsolute && platform === "windows") {
    return reject(
      "This workspace uses Windows paths, and a POSIX-style root would never match a Windows " +
        "candidate path. Enter a drive path such as C:\\projects\\app.",
    );
  }
  if ((driveAbsolute || isUnc) && platform === "posix") {
    return reject(
      "This workspace uses POSIX paths, and a Windows-style root would never match a POSIX " +
        "candidate path. Enter an absolute path such as /home/you/app.",
    );
  }

  // --- POSIX shape -------------------------------------------------------
  if (posixAbsolute) {
    const rawSegments = value.split("/");
    const segments: string[] = [];
    for (const segment of rawSegments.slice(1)) {
      if (segment === "") continue; // duplicate or trailing separator
      const problem = segmentProblem(segment, "posix");
      if (problem) return reject(problem);
      segments.push(segment);
    }
    const normalized = `/${segments.join("/")}`;
    if (normalized !== value) notes.push("Collapsed separators and removed the trailing slash.");
    if (segments.length === 0) {
      warnings.push("This grants the entire filesystem. Every path-like argument would pass.");
    } else if (
      (segments[0] === "home" || segments[0] === "Users") &&
      segments.length === 2
    ) {
      warnings.push(
        "This is a whole home directory — it includes ~/.ssh, ~/.aws and other credential stores.",
      );
    }
    return { ok: true, value: normalized, notes, warnings };
  }

  // --- Windows shapes ----------------------------------------------------
  const rawSegments = value.split(/[\\/]/);
  let anchor: string;
  let bodyStart: number;

  if (isUnc) {
    // "\\server\share\rest" splits to ["", "", "server", "share", "rest"].
    const server = rawSegments[2] ?? "";
    const share = rawSegments[3] ?? "";
    if (!server || !share) {
      return reject(
        "A UNC root must name both the server and the share, for example \\\\server\\share\\folder.",
      );
    }
    const serverProblem = segmentProblem(server, "windows");
    if (serverProblem) return reject(serverProblem);
    const shareProblem = segmentProblem(share, "windows");
    if (shareProblem) return reject(shareProblem);
    anchor = `\\\\${server}\\${share}`;
    bodyStart = 4;
  } else {
    const drive = driveAbsolute![1].toUpperCase();
    if (drive !== driveAbsolute![1]) notes.push("Upper-cased the drive letter.");
    anchor = `${drive}:`;
    bodyStart = 1;
  }

  const segments: string[] = [];
  for (const segment of rawSegments.slice(bodyStart)) {
    if (segment === "") continue; // duplicate or trailing separator
    const problem = segmentProblem(segment, "windows");
    if (problem) return reject(problem);
    segments.push(segment);
  }

  const normalized = segments.length > 0 ? `${anchor}\\${segments.join("\\")}` : `${anchor}\\`;
  if (normalized !== value) {
    notes.push("Normalised separators to backslashes and removed any trailing separator.");
  }
  notes.push(
    "Directory-name capitalisation is compared case-sensitively by the in-process runtime — " +
      "it must match the on-disk spelling. Browse… captures it exactly.",
  );

  if (segments.length === 0) {
    warnings.push(
      isUnc
        ? `This grants the entire ${anchor} share.`
        : `This grants the entire ${anchor} drive. Every path-like argument on it would pass.`,
    );
  } else if (!isUnc && segments.length === 2 && segments[0].toLowerCase() === "users") {
    warnings.push(
      "This is a whole user profile — it includes .ssh, .aws and other credential stores.",
    );
  }

  return { ok: true, value: normalized, notes, warnings };
}

/** Compare two normalised roots the way the LOOSER engine (Node) would. */
function sameRoot(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Is `candidate` already covered by `root`? Component-wise, matching the
 * stricter Rust check but case-folded so the answer is conservative (it only
 * ever reports MORE coverage, which suppresses a redundant add).
 */
export function mcpRootCovers(root: string, candidate: string): boolean {
  const separator = root.includes("\\") ? "\\" : "/";
  const anchored = root.endsWith(separator) ? root : `${root}${separator}`;
  return sameRoot(root, candidate) || candidate.toLowerCase().startsWith(anchored.toLowerCase());
}

/**
 * Decide whether a validated root may join the list. Kept separate from
 * `normalizeMcpRoot` so the editor can render "will be saved as" for a value
 * that is well-formed but redundant.
 */
export function mcpRootAddition(
  normalized: string,
  existing: string[],
): { status: "add" } | { status: "duplicate"; existing: string } | { status: "covered"; existing: string } | { status: "full" } {
  const duplicate = existing.find((root) => sameRoot(root, normalized));
  if (duplicate) return { status: "duplicate", existing: duplicate };
  if (existing.length >= MCP_ROOT_LIMIT) return { status: "full" };
  const covering = existing.find((root) => mcpRootCovers(root, normalized));
  if (covering) return { status: "covered", existing: covering };
  return { status: "add" };
}

/**
 * Roots are only consulted when the `outside_workspace` denial floor is armed.
 * Without it the list is inert, which the editor has to say rather than imply.
 */
export function mcpRootsEnforced(denialFloors: readonly string[]): boolean {
  return denialFloors.includes("outside_workspace");
}
