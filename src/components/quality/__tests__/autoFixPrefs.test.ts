// v0.8.8 quality autofix
//
// Smoke tests for the localStorage-backed "Auto-fix on next run"
// preference helper. Verifies the read/write contract used by the
// CodeQualityModal and AutoFixPanel.

import { describe, it, expect, beforeEach } from "vitest";
import {
  QUALITY_AUTOFIX_STORAGE_KEY,
  readAutoFixPref,
  writeAutoFixPref,
} from "../autoFixPrefs";

describe("autoFixPrefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("reads false when the key is unset", () => {
    expect(readAutoFixPref()).toBe(false);
  });

  it("persists true under the namespaced key", () => {
    writeAutoFixPref(true);
    expect(window.localStorage.getItem(QUALITY_AUTOFIX_STORAGE_KEY)).toBe("1");
    expect(readAutoFixPref()).toBe(true);
  });

  it("removes the key when set to false", () => {
    writeAutoFixPref(true);
    writeAutoFixPref(false);
    expect(window.localStorage.getItem(QUALITY_AUTOFIX_STORAGE_KEY)).toBeNull();
    expect(readAutoFixPref()).toBe(false);
  });

  it("uses the documented packetade-namespaced key", () => {
    expect(QUALITY_AUTOFIX_STORAGE_KEY).toBe("packetade:quality-autofix");
  });
});
