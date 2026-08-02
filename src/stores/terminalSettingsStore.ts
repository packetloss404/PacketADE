import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import { AUTO_TERMINAL_SHELL, normalizeTerminalShellSelection } from "@/lib/terminalShells";
import type { TerminalShellSelection } from "@/types/terminal-shell";

const DEFAULT_SHELL_KEY = storageKey("terminal-default-shell");

function loadDefaultShell(): TerminalShellSelection {
  if (typeof localStorage === "undefined") return AUTO_TERMINAL_SHELL;
  try {
    const raw = localStorage.getItem(DEFAULT_SHELL_KEY);
    return raw ? normalizeTerminalShellSelection(JSON.parse(raw)) : AUTO_TERMINAL_SHELL;
  } catch {
    return AUTO_TERMINAL_SHELL;
  }
}

function persistDefaultShell(selection: TerminalShellSelection) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(DEFAULT_SHELL_KEY, JSON.stringify(selection));
  } catch {
    // Runtime state remains authoritative for this launch if storage is unavailable.
  }
}

interface TerminalSettingsStore {
  defaultShell: TerminalShellSelection;
  setDefaultShell: (selection: TerminalShellSelection) => void;
  resetDefaultShell: () => void;
}

export const useTerminalSettingsStore = create<TerminalSettingsStore>((set) => ({
  defaultShell: loadDefaultShell(),
  setDefaultShell: (input) => {
    const selection = normalizeTerminalShellSelection(input);
    persistDefaultShell(selection);
    set({ defaultShell: selection });
  },
  resetDefaultShell: () => {
    persistDefaultShell(AUTO_TERMINAL_SHELL);
    set({ defaultShell: AUTO_TERMINAL_SHELL });
  },
}));
