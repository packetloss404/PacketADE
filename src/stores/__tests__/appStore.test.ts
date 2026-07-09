/**
 * appStore view normalization (H3).
 *
 * The `"agents"` CoreView was retired with the Agents tab, and its one-release
 * redirect shim is now deleted. A user whose persisted `selectedView` (or a
 * stale pre-cutover deep link) still carries the now-invalid `"agents"` string
 * must land on the workspace surface — never a value the App render switch no
 * longer handles, which would fall through to a blank screen. `setActiveView`
 * is the single mutation chokepoint, so the guard lives there.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeView, useAppStore, type AppView } from "@/stores/appStore";

beforeEach(() => {
  useAppStore.setState({ activeView: "welcome" });
});

describe("appStore view normalization", () => {
  it("normalizes a legacy persisted \"agents\" view to workspace", () => {
    // Simulate a straggler value arriving from disk / a stale deep link. The
    // literal is no longer part of the AppView union, so cast at the boundary
    // exactly as a hydration path handling an untyped persisted string would.
    expect(normalizeView("agents" as AppView)).toBe("workspace");
  });

  it("passes valid views through untouched", () => {
    expect(normalizeView("memory")).toBe("memory");
    expect(normalizeView("workspace")).toBe("workspace");
    expect(normalizeView("mod:git" as AppView)).toBe("mod:git");
  });

  it("setActiveView lands a legacy \"agents\" value on workspace, never blank", () => {
    useAppStore.getState().setActiveView("agents" as AppView);
    expect(useAppStore.getState().activeView).toBe("workspace");
  });

  it("setActiveView still honors real view changes", () => {
    useAppStore.getState().setActiveView("flights");
    expect(useAppStore.getState().activeView).toBe("flights");
  });
});
