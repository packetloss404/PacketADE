import type { McpCatalogManifest } from "@/types/mcp";

export const MCP_CATALOG: McpCatalogManifest[] = [
  {
    schemaVersion: 1,
    id: "official-filesystem",
    name: "Filesystem",
    description:
      "Official local filesystem server. PacketADE scopes it to the active project path in the review step.",
    officialSource: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    platforms: ["windows", "macos", "linux"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "$PROJECT_PATH"],
    requiredSecrets: [],
    capabilitySummary: ["read files", "write files", "search", "directory metadata"],
    removal: "Remove the server from MCP Hub; no project files are deleted.",
    needsNetwork: true,
    networkUse:
      "The first npx launch may download the package; after installation the server itself only accesses local files.",
  },
  {
    schemaVersion: 1,
    id: "official-github",
    name: "GitHub",
    description:
      "GitHub's official local MCP server, installed in read-only and lockdown mode by default.",
    officialSource: "https://github.com/github/github-mcp-server",
    platforms: ["windows", "macos", "linux"],
    transport: "stdio",
    command: "docker",
    args: [
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "-e",
      "GITHUB_READ_ONLY=1",
      "-e",
      "GITHUB_LOCKDOWN_MODE=1",
      "ghcr.io/github/github-mcp-server",
    ],
    requiredSecrets: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    capabilitySummary: ["repositories", "issues", "pull requests", "actions"],
    removal:
      "Remove the server from MCP Hub; optionally remove the cached Docker image separately.",
    needsNetwork: true,
    networkUse: "Docker may pull the image, and the running server connects to the GitHub API.",
  },
];

const SECRET_VALUE = /(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}/i;
const SHELL_META = /[;&|`><\n\r]/;

export function validateMcpCatalog(manifests: McpCatalogManifest[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const manifest of manifests) {
    if (manifest.schemaVersion !== 1) {
      errors.push(`${manifest.id}: unsupported schema`);
    }
    if (!manifest.id || ids.has(manifest.id)) {
      errors.push(`${manifest.id || "(missing id)"}: duplicate or missing id`);
    }
    ids.add(manifest.id);
    if (!manifest.officialSource.startsWith("https://")) {
      errors.push(`${manifest.id}: source must use HTTPS`);
    }
    if (
      SECRET_VALUE.test(
        `${manifest.command}\n${manifest.args.join("\n")}\n${manifest.requiredSecrets.join("\n")}`,
      )
    ) {
      errors.push(`${manifest.id}: manifest contains a secret-like value`);
    }
    if (SHELL_META.test(manifest.command)) {
      errors.push(`${manifest.id}: command contains shell metacharacters`);
    }
    if (manifest.args.some((argument) => /[\n\r]/.test(argument))) {
      errors.push(`${manifest.id}: argument contains a newline`);
    }
    if (!manifest.networkUse.trim()) {
      errors.push(`${manifest.id}: network use disclosure is required`);
    }
  }
  return errors;
}

export function materializeCatalogCommand(
  manifest: McpCatalogManifest,
  projectPath: string,
  platform = navigator.platform.toLowerCase(),
): { command: string; args: string[]; env: Record<string, string> } {
  const normalizedPlatform = platform.toLowerCase();
  const args = manifest.args.map((argument) =>
    argument === "$PROJECT_PATH" ? projectPath : argument,
  );
  // Required secret *names* are review metadata. Never persist an empty
  // placeholder because it would override an existing process environment
  // value (and it would misleadingly look like PacketADE owns the secret).
  const env: Record<string, string> = {};
  if (
    manifest.command === "npx" &&
    (normalizedPlatform.includes("win") || normalizedPlatform.includes("windows"))
  ) {
    return { command: "cmd", args: ["/c", "npx", ...args], env };
  }
  return { command: manifest.command, args, env };
}
