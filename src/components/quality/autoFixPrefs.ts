// v0.8.8 quality autofix
//
// Tiny localStorage-backed preference: "Auto-fix on next run". The
// CodeQualityModal consults this before running its analyzer/lint pass
// so the next run can pre-apply ESLint --fix + Prettier --write.
//
// Keyed under the `packetbench:` namespace per CLAUDE.md.

export const QUALITY_AUTOFIX_STORAGE_KEY = "packetbench:quality-autofix";

export function normalizeAutoFixProjectPath(projectPath: string): string {
  const trimmed = projectPath.trim();
  if (!trimmed) return "";

  const slashNormalized = trimmed.replace(/\\/g, "/");
  const withoutTrailingSlash = slashNormalized.replace(/\/+$/, "");
  const normalized = withoutTrailingSlash || (slashNormalized.startsWith("/") ? "/" : "");

  return normalized.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
}

export function autoFixPrefStorageKey(projectPath: string): string {
  return `${QUALITY_AUTOFIX_STORAGE_KEY}:project:${encodeURIComponent(
    normalizeAutoFixProjectPath(projectPath),
  )}`;
}

export function readAutoFixPref(projectPath: string): boolean {
  try {
    if (typeof window === "undefined") return false;
    const normalizedProjectPath = normalizeAutoFixProjectPath(projectPath);
    if (!normalizedProjectPath) return false;

    const scopedKey = autoFixPrefStorageKey(normalizedProjectPath);
    if (window.localStorage.getItem(scopedKey) === "1") return true;

    if (window.localStorage.getItem(QUALITY_AUTOFIX_STORAGE_KEY) === "1") {
      window.localStorage.setItem(scopedKey, "1");
      window.localStorage.removeItem(QUALITY_AUTOFIX_STORAGE_KEY);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function writeAutoFixPref(value: boolean, projectPath: string): void {
  try {
    if (typeof window === "undefined") return;
    const normalizedProjectPath = normalizeAutoFixProjectPath(projectPath);
    if (!normalizedProjectPath) return;

    const scopedKey = autoFixPrefStorageKey(normalizedProjectPath);
    if (value) {
      window.localStorage.setItem(scopedKey, "1");
    } else {
      window.localStorage.removeItem(scopedKey);
    }
    window.localStorage.removeItem(QUALITY_AUTOFIX_STORAGE_KEY);
  } catch {
    // ignore quota / disabled-storage errors
  }
}
