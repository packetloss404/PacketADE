import type {
  DetectedTerminalShell,
  TerminalShellProfileId,
  TerminalShellSelection,
} from "@/types/terminal-shell";

export type TerminalPlatform = "windows" | "posix";

export const AUTO_TERMINAL_SHELL: TerminalShellSelection = { profile: "auto" };

export const CUSTOM_SHELL_PROGRAMS = [
  "bash",
  "cmd",
  "fish",
  "nu",
  "powershell",
  "pwsh",
  "sh",
  "wsl",
  "xonsh",
  "zsh",
] as const;

const PROFILE_IDS = new Set<TerminalShellProfileId>([
  "auto",
  "powershell7",
  "windows-powershell",
  "command-prompt",
  "git-bash",
  "wsl",
  "bash",
  "zsh",
  "custom",
]);

export function terminalPlatform(): TerminalPlatform {
  if (typeof navigator === "undefined") return "posix";
  const identity = `${navigator.userAgent ?? ""} ${navigator.platform ?? ""}`;
  return /windows|win32|win64/i.test(identity) ? "windows" : "posix";
}

export function normalizeTerminalShellSelection(value: unknown): TerminalShellSelection {
  if (!value || typeof value !== "object") return AUTO_TERMINAL_SHELL;
  const candidate = value as Partial<TerminalShellSelection>;
  if (!candidate.profile || !PROFILE_IDS.has(candidate.profile)) {
    return AUTO_TERMINAL_SHELL;
  }

  const executable =
    typeof candidate.executable === "string" && candidate.executable.trim()
      ? candidate.executable.trim()
      : undefined;
  const args = Array.isArray(candidate.args)
    ? candidate.args
        .filter((arg): arg is string => typeof arg === "string")
        .map((arg) => arg.trim())
        .filter(Boolean)
        .slice(0, 32)
    : undefined;
  const wslDistro =
    typeof candidate.wslDistro === "string" && candidate.wslDistro.trim()
      ? candidate.wslDistro.trim()
      : undefined;

  return {
    profile: candidate.profile,
    ...(executable ? { executable } : {}),
    ...(args?.length ? { args } : {}),
    ...(wslDistro ? { wslDistro } : {}),
  };
}

export function shellProfileLabel(profile: TerminalShellProfileId): string {
  switch (profile) {
    case "auto":
      return "Auto-detect";
    case "powershell7":
      return "PowerShell 7";
    case "windows-powershell":
      return "Windows PowerShell";
    case "command-prompt":
      return "Command Prompt";
    case "git-bash":
      return "Git Bash";
    case "wsl":
      return "WSL";
    case "bash":
      return "Bash";
    case "zsh":
      return "Zsh";
    case "custom":
      return "Custom executable";
  }
}

export function shellProfilesForPlatform(platform: TerminalPlatform): TerminalShellProfileId[] {
  return platform === "windows"
    ? ["auto", "powershell7", "windows-powershell", "command-prompt", "git-bash", "wsl", "custom"]
    : ["auto", "bash", "zsh", "custom"];
}

export function customShellProgram(executable: string): string {
  const filename = executable.trim().split(/[\\/]/).pop() ?? "";
  return filename.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

export function isSupportedCustomShell(executable: string): boolean {
  const program = customShellProgram(executable);
  return CUSTOM_SHELL_PROGRAMS.some((candidate) => candidate === program);
}

/** Parse a compact argument field without invoking either Windows or POSIX shell syntax. */
export function parseTerminalShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  const source = input.trim();
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      // Preserve ordinary Windows path separators. Backslash is an escape
      // only before whitespace, a quote, or another backslash.
      if (next && (/\s/.test(next) || next === "\\" || next === '"' || next === "'")) {
        current += next;
        index += 1;
      } else {
        current += "\\";
      }
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args.slice(0, 32);
}

export function formatTerminalShellArgs(args?: string[]): string {
  return (args ?? [])
    .map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(" ");
}

export function selectionForProfile(
  profile: TerminalShellProfileId,
  detected?: DetectedTerminalShell,
): TerminalShellSelection {
  return {
    profile,
    ...(detected?.path ? { executable: detected.path } : {}),
  };
}

export interface TerminalShellLaunch {
  command: string;
  args: string[];
  label: string;
}

/** Resolve one stored choice into PTY launch arguments without invoking a shell. */
export function resolveTerminalShellLaunch(
  input: TerminalShellSelection | undefined,
  autoCommand: string,
): TerminalShellLaunch {
  const selection = normalizeTerminalShellSelection(input);
  const executable = selection.executable?.trim();

  switch (selection.profile) {
    case "powershell7":
      return { command: executable || "pwsh", args: selection.args ?? [], label: "PowerShell 7" };
    case "windows-powershell":
      return {
        command: executable || "powershell",
        args: selection.args ?? [],
        label: "Windows PowerShell",
      };
    case "command-prompt":
      return { command: executable || "cmd", args: selection.args ?? [], label: "Command Prompt" };
    case "git-bash":
      return {
        command: executable || "bash",
        args: selection.args ?? ["--login", "-i"],
        label: "Git Bash",
      };
    case "wsl":
      return {
        command: executable || "wsl",
        args:
          selection.args ?? (selection.wslDistro ? ["--distribution", selection.wslDistro] : []),
        label: selection.wslDistro ? `WSL · ${selection.wslDistro}` : "WSL",
      };
    case "bash":
      return { command: executable || "bash", args: selection.args ?? [], label: "Bash" };
    case "zsh":
      return { command: executable || "zsh", args: selection.args ?? [], label: "Zsh" };
    case "custom":
      if (executable && isSupportedCustomShell(executable)) {
        return { command: executable, args: selection.args ?? [], label: "Custom shell" };
      }
      return { command: autoCommand, args: [], label: "Auto-detect" };
    case "auto":
    default:
      // Compatibility contract: byte-for-byte the old command/args choice.
      return { command: autoCommand, args: [], label: "Auto-detect" };
  }
}
