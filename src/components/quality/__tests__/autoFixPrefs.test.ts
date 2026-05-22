// v0.8.8 quality autofix
//
// Smoke tests for the localStorage-backed "Auto-fix on next run"
// preference helper. Verifies the read/write contract used by the
// CodeQualityModal and AutoFixPanel.

import { describe, it, expect, beforeEach } from "vitest";
import {
  QUALITY_AUTOFIX_STORAGE_KEY,
  autoFixPrefStorageKey,
  normalizeAutoFixProjectPath,
  readAutoFixPref,
  writeAutoFixPref,
} from "../autoFixPrefs";

describe("autoFixPrefs", () => {
  const projectA = "/Users/ian/projects/ProjectA";
  const projectB = "/Users/ian/projects/ProjectB";

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("reads false when the key is unset", () => {
    expect(readAutoFixPref(projectA)).toBe(false);
  });

  it("persists true under a normalized project-scoped key", () => {
    writeAutoFixPref(true, `${projectA}/`);

    expect(window.localStorage.getItem(autoFixPrefStorageKey(projectA))).toBe("1");
    expect(window.localStorage.getItem(QUALITY_AUTOFIX_STORAGE_KEY)).toBeNull();
    expect(readAutoFixPref(projectA)).toBe(true);
  });

  it("does not leak the preference between projects", () => {
    writeAutoFixPref(true, projectA);

    expect(readAutoFixPref(projectA)).toBe(true);
    expect(readAutoFixPref(projectB)).toBe(false);
  });

  it("removes only the matching project key when set to false", () => {
    writeAutoFixPref(true, projectA);
    writeAutoFixPref(true, projectB);
    writeAutoFixPref(false, projectA);

    expect(window.localStorage.getItem(autoFixPrefStorageKey(projectA))).toBeNull();
    expect(readAutoFixPref(projectA)).toBe(false);
    expect(readAutoFixPref(projectB)).toBe(true);
  });

  it("normalizes path separators and trailing slashes", () => {
    expect(normalizeAutoFixProjectPath("C:\\Users\\Ian\\Project\\")).toBe("c:/Users/Ian/Project");
  });

  it("migrates the legacy global key once to the current project", () => {
    window.localStorage.setItem(QUALITY_AUTOFIX_STORAGE_KEY, "1");

    expect(readAutoFixPref(projectA)).toBe(true);
    expect(window.localStorage.getItem(QUALITY_AUTOFIX_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(autoFixPrefStorageKey(projectA))).toBe("1");
    expect(readAutoFixPref(projectB)).toBe(false);
  });

  it("keeps the legacy key available for migration", () => {
    expect(QUALITY_AUTOFIX_STORAGE_KEY).toBe("packetade:quality-autofix");
  });
});
