import { describe, it, expect, beforeEach } from "vitest";
import { useProfileStore } from "../profileStore";

const store = () => useProfileStore.getState();

const BUILTIN_IDS = ["auto", "speed-runner", "thorough-reviewer", "security-auditor", "refactor-pro"];

function baseProfile(overrides: Record<string, unknown> = {}) {
  return {
    name: "My Profile",
    description: "desc",
    icon: "Zap",
    color: "text-accent-green",
    systemPrompt: "be helpful",
    defaultModel: "",
    ...overrides,
  };
}

describe("profileStore", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset to only builtins
    useProfileStore.setState({
      profiles: store().profiles.filter((p) => p.isBuiltin),
      activeProfileId: null,
    });
  });

  it("loads builtin profiles", () => {
    const ids = store().profiles.map((p) => p.id);
    for (const id of BUILTIN_IDS) {
      expect(ids).toContain(id);
    }
  });

  it("addProfile adds a non-builtin profile and persists it", () => {
    store().addProfile(baseProfile({ name: "Custom" }));
    const added = store().profiles.find((p) => p.name === "Custom")!;
    expect(added).toBeDefined();
    expect(added.isBuiltin).toBe(false);
    expect(added.id).toMatch(/^custom-/);
    const raw = JSON.parse(localStorage.getItem("packetcode:profiles")!);
    expect(raw.some((p: { name: string }) => p.name === "Custom")).toBe(true);
  });

  it("updateProfile updates a user profile but preserves id and isBuiltin", () => {
    store().addProfile(baseProfile({ name: "Original" }));
    const id = store().profiles.find((p) => p.name === "Original")!.id;
    store().updateProfile(id, { name: "Renamed", isBuiltin: true });
    const updated = store().profiles.find((p) => p.id === id)!;
    expect(updated.name).toBe("Renamed");
    expect(updated.isBuiltin).toBe(false);
    expect(updated.id).toBe(id);
  });

  it("deleteProfile removes a user profile", () => {
    store().addProfile(baseProfile({ name: "ToDelete" }));
    const id = store().profiles.find((p) => p.name === "ToDelete")!.id;
    store().deleteProfile(id);
    expect(store().profiles.find((p) => p.id === id)).toBeUndefined();
  });

  it("deleteProfile refuses to delete a builtin profile", () => {
    store().deleteProfile("auto");
    expect(store().profiles.find((p) => p.id === "auto")).toBeDefined();
  });

  it("deleteProfile clears activeProfileId if it was the deleted profile", () => {
    store().addProfile(baseProfile({ name: "Active" }));
    const id = store().profiles.find((p) => p.name === "Active")!.id;
    store().setActiveProfile(id);
    expect(store().activeProfileId).toBe(id);
    store().deleteProfile(id);
    expect(store().activeProfileId).toBeNull();
  });

  it("setActiveProfile persists and clears from localStorage", () => {
    store().setActiveProfile("speed-runner");
    expect(store().activeProfileId).toBe("speed-runner");
    expect(localStorage.getItem("packetcode:active-profile")).toBe("speed-runner");
    store().setActiveProfile(null);
    expect(store().activeProfileId).toBeNull();
    expect(localStorage.getItem("packetcode:active-profile")).toBeNull();
  });

  it("getProfile returns a profile by id or undefined", () => {
    expect(store().getProfile("auto")?.name).toBe("Auto (Optimized)");
    expect(store().getProfile("nope")).toBeUndefined();
  });
});
