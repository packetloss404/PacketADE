import type { ServerConfig } from "@/types/server";

/** Shell-escape a string for safe embedding in a remote command. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Build SSH command-line args for spawning a remote CLI session via PTY. */
export function buildSshArgs(
  server: ServerConfig,
  remotePath: string,
  remoteCommand: string,
  remoteArgs?: string[],
): string[] {
  const args: string[] = ["-t"]; // force pseudo-terminal allocation

  if (server.port !== 22) {
    args.push("-p", String(server.port));
  }

  if (server.authMethod === "key" && server.keyPath) {
    args.push("-i", server.keyPath);
  }

  args.push(`${server.username}@${server.host}`);

  // Build the remote command string
  const cmdParts = [remoteCommand, ...(remoteArgs ?? [])].join(" ");
  const remoteCmd = remotePath
    ? `cd ${shellEscape(remotePath)} && ${cmdParts}`
    : cmdParts;
  args.push(remoteCmd);

  return args;
}

/** Build SSH args for running a one-shot command (detection, install). */
export function buildSshExecArgs(
  server: ServerConfig,
  remoteCommand: string,
): string[] {
  const args: string[] = ["-t"];

  if (server.port !== 22) {
    args.push("-p", String(server.port));
  }

  if (server.authMethod === "key" && server.keyPath) {
    args.push("-i", server.keyPath);
  }

  args.push(`${server.username}@${server.host}`);
  args.push(remoteCommand);

  return args;
}

/** Install commands for each agent CLI on a remote server. */
export const REMOTE_INSTALL_COMMANDS: Record<string, string> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
  codex: "npm install -g @openai/codex",
  gemini: "npm install -g @anthropic-ai/gemini-cli",
};

/** Map agent IDs to the CLI command name to check on the remote. */
export const AGENT_CLI_NAMES: Record<string, string> = {
  "claude-code": "claude",
  opencode: "opencode",
  codex: "codex",
  gemini: "gemini",
};
