// v0.8.8 quality autofix
//
// Tiny localStorage-backed preference: "Auto-fix on next run". The
// CodeQualityModal consults this before running its analyzer/lint pass
// so the next run can pre-apply ESLint --fix + Prettier --write.
//
// Keyed under the `packetade:` namespace per CLAUDE.md.

export const QUALITY_AUTOFIX_STORAGE_KEY = "packetade:quality-autofix";

export function readAutoFixPref(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(QUALITY_AUTOFIX_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAutoFixPref(value: boolean): void {
  try {
    if (typeof window === "undefined") return;
    if (value) {
      window.localStorage.setItem(QUALITY_AUTOFIX_STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(QUALITY_AUTOFIX_STORAGE_KEY);
    }
  } catch {
    // ignore quota / disabled-storage errors
  }
}
