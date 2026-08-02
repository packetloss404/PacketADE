export type TerminalShellProfileId =
  | "auto"
  | "powershell7"
  | "windows-powershell"
  | "command-prompt"
  | "git-bash"
  | "wsl"
  | "bash"
  | "zsh"
  | "custom";

/**
 * Persisted shell choice for a raw local Terminal pane.
 *
 * An absent selection and `profile: "auto"` are deliberately equivalent:
 * both preserve the historical PacketADE launch (`powershell` on Windows,
 * `bash` elsewhere). Dedicated coding CLI panes and SSH sessions do not read
 * this setting.
 */
export interface TerminalShellSelection {
  profile: TerminalShellProfileId;
  /** Resolved or user-selected executable. Optional for built-in profiles. */
  executable?: string;
  /** Optional startup arguments, primarily for custom shells. */
  args?: string[];
  /** WSL distribution passed to `wsl --distribution`, when selected. */
  wslDistro?: string;
}

export interface DetectedTerminalShell {
  profile: TerminalShellProfileId;
  available: boolean;
  path: string | null;
  version: string | null;
}

export interface TerminalShellProbe {
  available: boolean;
  executable: string;
  version: string | null;
  workingDirectory: string;
  platform: string;
}
